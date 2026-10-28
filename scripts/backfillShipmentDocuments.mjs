#!/usr/bin/env node
/**
 * Backfill the shipment document index (Step E) from the paperwork that already exists.
 *
 * Four passes, in the order a reviewer reads them:
 *   (a) every APPROVED driver-app POD on a load that belongs to a shipment becomes a
 *       `drv:<submissionDocId>` POINTER row — `s3Key` is the key the driver app already
 *       wrote, so no bytes move and the PODs page stays the truth about what a driver sent;
 *   (b) a load's legacy `rateConfirmKey` becomes a `rck:<loadId>` CUSTOMER_RATE_CON row in
 *       the Customer section, INTERNAL, because that file is the customer's rate
 *       confirmation to us and is not ours to forward;
 *   (c) `Customer.requiredDocsForInvoice` and `TmsSettings.defaultRequiredDocs` are rewritten
 *       through `normalizeRequiredDocTypes`, so the free text people typed before step E gave
 *       them a vocabulary becomes typed values. Anything the vocabulary does not recognise is
 *       PRINTED for Ryne and LEFT on the record: a customer's instruction we cannot gate on is
 *       still a customer's instruction, and dropping it silently would lose it;
 *   (d) `Order.docsRequired` / `docsMissing` / `docsCheckedAt` are computed with the same
 *       `evaluateDocGate` the Lambda uses, so the board's Docs column is right the first time
 *       rather than only after somebody touches each order.
 *
 * Every pass is keyed by a deterministic id or compares against what is already stored, so a
 * re-run — or a run that died half way — writes nothing twice. Nothing is invented: a load with
 * no POD simply gets no row.
 *
 * Dry run is the default and writes NOTHING to AWS: it prints the counts per pass and the
 * unrecognised-string report, and writes a plan file when `--plan` is given. `--apply` replays
 * that reviewed plan after checking the source rows have not moved underneath it.
 *
 * The guard that matters here is the TABLE SUFFIX, not a flag a human types: this script talks
 * to DynamoDB directly (there is no Lambda action for a migration that touches five models), so
 * the environment is read off the tables it was pointed at and the production suffix is refused
 * outright.
 *
 *   node scripts/backfillShipmentDocuments.mjs --help
 *   node scripts/backfillShipmentDocuments.mjs --plan plans/e-docs.json
 *   node scripts/backfillShipmentDocuments.mjs --apply --plan plans/e-docs.json
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseTmsArgs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';
// Node strips the types at run time, so the script shares the Lambda's rules rather than
// restating them. A second copy of the gate would stay right for exactly one release.
import {
  PDF_CONTENT_TYPE,
  evaluateDocGate,
  normalizeRequiredDocTypes,
  nextVersion,
  driverDocumentId,
  legacyRateConDocumentId,
} from '../src/lib/shipmentDocuments.ts';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
/** Who the audit trail says did this. Not a person: a script, named so it can be found again. */
export const MIGRATION_USER = 'migration:backfillShipmentDocuments';

const MODELS = [
  'Load', 'Order', 'LoadCarrier', 'Customer', 'TmsSettings',
  'DriverSubmission', 'DriverSubmissionDoc', 'ShipmentDocument', 'AuditLog',
];

const USAGE = `
Usage: node scripts/backfillShipmentDocuments.mjs [options]

Options:
  --help, -h        Show this offline help.
  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

Dry run reads the tables, prints what each of the four passes would do, and writes
nothing to AWS. Apply re-reads the same tables, refuses a plan whose sources have
changed, and then writes the rows under their deterministic ids.
`;

/**
 * The environment is the tables, so the environment is checked on the tables.
 * @param {string | undefined} value
 * @returns {{suffix: string, environment: string}}
 */
export function resolveTarget(value) {
  const suffix = (value ?? process.env.TABLE_SUFFIX ?? DEV_TABLE_SUFFIX).trim();
  if (!suffix) throw new Error('--suffix <tableSuffix> cannot be empty');
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(
      `Refusing to run against production tables (${suffix}): this backfill writes ShipmentDocument rows ` +
        'and rewrites Customer, TmsSettings and Order fields, and Step E is a dev-only build. ' +
        `Point it at the dev suffix (${DEV_TABLE_SUFFIX}).`
    );
  }
  return { suffix, environment: suffix === DEV_TABLE_SUFFIX ? 'dev' : suffix };
}

/** @param {string} key @returns {string} */
function basename(key) {
  return String(key).split('/').pop() || String(key);
}

const EXTENSION_CONTENT_TYPES = {
  pdf: PDF_CONTENT_TYPE,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * What the file in the other store is. The driver app records a content type on the page
 * rows; a merged PDF and a legacy rate con only have their key to go on.
 * @param {string} key
 * @param {string | null | undefined} recorded
 * @returns {string}
 */
export function contentTypeFor(key, recorded) {
  if (typeof recorded === 'string' && recorded.trim()) return recorded.trim();
  const ext = basename(key).split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_CONTENT_TYPES[ext] ?? PDF_CONTENT_TYPE;
}

/**
 * What every backfilled row carries: version 1 (nothing here supersedes anything), ACTIVE, and
 * the migration as its author. `reviewStatus` is deliberately absent — that index is the staff
 * review worklist, and a row the backfill wrote was never a carrier-portal upload.
 *
 * A pointer row's bytes belong to the store that wrote them, and this script never opens S3, so
 * a size it did not measure is written as 0 rather than guessed.
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function shipmentDocumentRow(item) {
  return {
    __typename: 'ShipmentDocument',
    status: 'ACTIVE',
    version: 1,
    orderId: null,
    loadId: null,
    loadCarrierId: null,
    stopId: null,
    pages: null,
    supersedesId: null,
    uploadedBy: MIGRATION_USER,
    createdBy: MIGRATION_USER,
    ...item,
  };
}

// ── Pass (a): driver-app PODs ────────────────────────────────────────────────

/**
 * One row per POD document, not one per page: once the pages have been merged, the POD IS the
 * merged PDF, and a row per page would list the same file five times. The row then hangs off
 * the first page's id so the id stays deterministic and matches ATTACH_DRIVER_DOC.
 *
 * The rows are emitted per load in `uploadedAt` order, so a load a driver sent two PODs for
 * gets v1 and v2 in the order they arrived rather than two v1s.
 *
 * @param {object} input
 * @param {any[]} input.submissions
 * @param {any[]} input.submissionDocs
 * @param {Map<string, any>} input.loadsById
 * @param {Set<string>} input.existingDocumentIds
 * @param {Map<string, any[]>} input.docsByShipment  rows already indexed, extended as we plan
 * @returns {{actions: any[], skipped: any[], alreadyIndexed: number, approved: number}}
 */
export function planDriverPodRows({ submissions, submissionDocs, loadsById, existingDocumentIds, docsByShipment }) {
  const pagesBySubmission = new Map();
  for (const doc of submissionDocs) {
    if (doc.kind !== 'POD') continue;
    const list = pagesBySubmission.get(doc.submissionId) ?? [];
    list.push(doc);
    pagesBySubmission.set(doc.submissionId, list);
  }

  const skipped = [];
  const candidates = [];
  let alreadyIndexed = 0;
  let approved = 0;

  const ordered = [...submissions].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const sub of ordered) {
    if (sub.podReviewStatus !== 'APPROVED') continue;
    approved += 1;
    if (!sub.loadId) {
      skipped.push({ submissionId: sub.id, reason: 'NO_LOAD' });
      continue;
    }
    const load = loadsById.get(String(sub.loadId));
    if (!load) {
      skipped.push({ submissionId: sub.id, loadId: sub.loadId, reason: 'LOAD_NOT_FOUND' });
      continue;
    }
    if (!load.shipmentId) {
      skipped.push({ submissionId: sub.id, loadId: sub.loadId, reason: 'LOAD_HAS_NO_SHIPMENT' });
      continue;
    }

    const pages = (pagesBySubmission.get(sub.id) ?? []).sort(
      (a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0) || String(a.id).localeCompare(String(b.id))
    );
    if (pages.length === 0) {
      // An approved review with no page rows: the POD was removed after approval. Nothing to
      // point at, and a row pointing at nothing is worse than no row.
      skipped.push({ submissionId: sub.id, loadId: sub.loadId, reason: 'NO_POD_PAGES' });
      continue;
    }

    // The same key ATTACH_DRIVER_DOC points at: the merged PDF when the pages have been
    // joined, otherwise the cleaned copy of the page, otherwise what the driver uploaded.
    const merged = typeof sub.combinedPodKey === 'string' && sub.combinedPodKey.trim()
      ? sub.combinedPodKey.trim()
      : null;
    const targets = merged
      ? [{
          page: pages[0],
          s3Key: merged,
          pages: pages.length,
          contentType: PDF_CONTENT_TYPE,
          sizeBytes: 0,
          name: `pod-${sub.referenceNumber ?? sub.id}.pdf`,
        }]
      : pages.map((page) => {
          const enhanced = typeof page.enhancedKey === 'string' && page.enhancedKey.trim() ? page.enhancedKey.trim() : null;
          return {
            page,
            s3Key: enhanced ?? String(page.s3Key),
            pages: 1,
            // The cleaned copy is a different file: its own key decides what it is, and the
            // original's recorded content type would describe the wrong bytes.
            contentType: enhanced ? contentTypeFor(enhanced, null) : contentTypeFor(page.s3Key, page.contentType),
            sizeBytes: enhanced ? 0 : (Number.isInteger(page.byteSize) ? page.byteSize : 0),
            name: page.fileName || `pod-${page.id}`,
          };
        });

    for (const target of targets) {
      const id = driverDocumentId(String(target.page.id));
      if (existingDocumentIds.has(id)) {
        alreadyIndexed += 1;
        continue;
      }
      candidates.push({
        id,
        sub,
        load,
        target,
        uploadedAt: String(target.page.uploadedAt ?? sub.createdAt ?? new Date().toISOString()),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      String(a.load.id).localeCompare(String(b.load.id)) ||
      a.uploadedAt.localeCompare(b.uploadedAt) ||
      a.id.localeCompare(b.id)
  );

  const actions = candidates.map(({ id, sub, load, target, uploadedAt }) => {
    const shipmentId = String(load.shipmentId);
    const siblings = docsByShipment.get(shipmentId) ?? [];
    const item = shipmentDocumentRow({
      id,
      shipmentId,
      loadId: String(load.id),
      type: 'POD',
      name: target.name,
      s3Key: target.s3Key,
      contentType: target.contentType,
      sizeBytes: target.sizeBytes,
      pages: target.pages,
      source: 'DRIVER_APP',
      sourceRef: String(sub.id),
      audience: 'ALL',
      version: nextVersion(siblings, 'POD', String(load.id)),
      // The driver app's own vocabulary for an author, so the Documents tab shows one kind of
      // author for a driver's POD however the row got there. The migration is the CREATOR.
      uploadedBy: `driver:${target.page.driverId ?? sub.driverId ?? 'unknown'}`,
      uploadedAt,
    });
    siblings.push(item);
    docsByShipment.set(shipmentId, siblings);
    return {
      action: 'PUT_SHIPMENT_DOCUMENT',
      pass: 'a',
      purpose: 'Point the shipment at the POD the driver app already holds',
      item,
    };
  });

  return { actions, skipped, alreadyIndexed, approved };
}

// ── Pass (b): legacy rate confirmations ──────────────────────────────────────

/**
 * @param {object} input
 * @param {any[]} input.loads
 * @param {Map<string, any>} input.orderByShipmentId
 * @param {Set<string>} input.existingDocumentIds
 * @param {Map<string, any[]>} input.docsByShipment  rows already indexed, extended as we plan
 * @returns {{actions: any[], skipped: any[], alreadyIndexed: number, withKey: number}}
 */
export function planLegacyRateConRows({ loads, orderByShipmentId, existingDocumentIds, docsByShipment }) {
  const actions = [];
  const skipped = [];
  let alreadyIndexed = 0;
  let withKey = 0;

  const ordered = [...loads].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const load of ordered) {
    const key = typeof load.rateConfirmKey === 'string' ? load.rateConfirmKey.trim() : '';
    if (!key) continue;
    withKey += 1;
    if (!load.shipmentId) {
      skipped.push({ loadId: load.id, reason: 'LOAD_HAS_NO_SHIPMENT' });
      continue;
    }
    const id = legacyRateConDocumentId(String(load.id));
    if (existingDocumentIds.has(id)) {
      alreadyIndexed += 1;
      continue;
    }
    // The Customer section is `orderId`; the load carries it after the Step B backfill, and
    // the order table is the fallback for a shipment whose load was linked by hand.
    const orderId = load.orderId ?? orderByShipmentId.get(String(load.shipmentId))?.id ?? null;
    if (!orderId) {
      skipped.push({ loadId: load.id, shipmentId: load.shipmentId, reason: 'NO_ORDER_FOR_SHIPMENT' });
      continue;
    }
    const siblings = docsByShipment.get(String(load.shipmentId)) ?? [];
    const item = shipmentDocumentRow({
      id,
      shipmentId: String(load.shipmentId),
      orderId: String(orderId),
      loadId: String(load.id),
      type: 'CUSTOMER_RATE_CON',
      name: basename(key),
      s3Key: key,
      contentType: contentTypeFor(key, null),
      sizeBytes: 0,
      source: 'LEGACY',
      sourceRef: String(load.id),
      // The customer's rate confirmation to us carries their rate. It never leaves.
      audience: 'INTERNAL',
      version: nextVersion(siblings, 'CUSTOMER_RATE_CON', String(load.id)),
      // The file arrived with the load, so the load's own creation is the honest stamp.
      uploadedAt: String(load.createdAt ?? load.updatedAt ?? new Date().toISOString()),
    });
    siblings.push(item);
    docsByShipment.set(String(load.shipmentId), siblings);
    actions.push({
      action: 'PUT_SHIPMENT_DOCUMENT',
      pass: 'b',
      purpose: 'Index the rate confirmation the customer sent with the load',
      item,
    });
  }

  return { actions, skipped, alreadyIndexed, withKey };
}

// ── Pass (c): required-document vocabulary ───────────────────────────────────

/**
 * @param {string[] | null | undefined} before
 * @param {string[]} after
 * @returns {boolean}
 */
function sameList(before, after) {
  const prev = Array.isArray(before) ? before.map(String) : [];
  return prev.length === after.length && prev.every((v, i) => v === after[i]);
}

/**
 * The unrecognised strings are kept at the end of the list rather than dropped: they cannot
 * gate an invoice, but they are still what somebody asked for, and the report tells Ryne which
 * ones need a decision.
 *
 * @param {object} input
 * @param {any[]} input.customers
 * @param {any[]} input.settings
 * @returns {{actions: any[], unrecognised: any[], alreadyTyped: number}}
 */
export function planRequiredDocRewrites({ customers, settings }) {
  const actions = [];
  const unrecognised = [];
  let alreadyTyped = 0;

  /** @param {string} table @param {string} field @param {any} row @param {string} label */
  const consider = (table, field, row, label) => {
    const before = Array.isArray(row[field]) ? row[field].map(String) : [];
    if (before.length === 0) return;
    const result = normalizeRequiredDocTypes(before);
    const after = [...result.types, ...result.unrecognised];
    if (result.unrecognised.length > 0) {
      unrecognised.push({ table, id: String(row.id), label, field, values: result.unrecognised });
    }
    if (sameList(before, after)) {
      alreadyTyped += 1;
      return;
    }
    actions.push({
      action: 'UPDATE_REQUIRED_DOCS',
      pass: 'c',
      purpose: 'Rewrite free-text required documents into the Step E vocabulary',
      table,
      id: String(row.id),
      field,
      label,
      before,
      after,
    });
  };

  for (const customer of [...customers].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    consider('Customer', 'requiredDocsForInvoice', customer, String(customer.name ?? customer.id));
  }
  for (const row of [...settings].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    consider('TmsSettings', 'defaultRequiredDocs', row, 'org defaults');
  }

  return { actions, unrecognised, alreadyTyped };
}

// ── Pass (d): the order document gate ────────────────────────────────────────

/**
 * @param {object} input
 * @param {any[]} input.orders
 * @param {any[]} input.loads
 * @param {any[]} input.loadCarriers
 * @param {any[]} input.customers
 * @param {any} input.settings
 * @param {any[]} input.documents  existing rows plus the ones passes (a) and (b) would write
 * @returns {{actions: any[], unchanged: number, notReady: number}}
 */
export function planOrderGates({ orders, loads, loadCarriers, customers, settings, documents }) {
  const customerById = new Map(customers.map((c) => [String(c.id), c]));
  const loadsByShipment = new Map();
  for (const load of loads) {
    if (!load.shipmentId) continue;
    const list = loadsByShipment.get(String(load.shipmentId)) ?? [];
    list.push(load);
    loadsByShipment.set(String(load.shipmentId), list);
  }
  const carriersByShipment = new Map();
  for (const lc of loadCarriers) {
    if (!lc.shipmentId) continue;
    const list = carriersByShipment.get(String(lc.shipmentId)) ?? [];
    list.push(lc);
    carriersByShipment.set(String(lc.shipmentId), list);
  }
  const documentsByShipment = new Map();
  for (const doc of documents) {
    const list = documentsByShipment.get(String(doc.shipmentId)) ?? [];
    list.push(doc);
    documentsByShipment.set(String(doc.shipmentId), list);
  }

  const actions = [];
  let unchanged = 0;
  let notReady = 0;

  for (const order of [...orders].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const shipmentId = String(order.shipmentId ?? '');
    const gate = evaluateDocGate({
      order,
      loadIds: (loadsByShipment.get(shipmentId) ?? []).map((l) => String(l.id)),
      loadCarriers: carriersByShipment.get(shipmentId) ?? [],
      documents: documentsByShipment.get(shipmentId) ?? [],
      customer: customerById.get(String(order.customerId)) ?? null,
      settings,
      scope: 'CUSTOMER',
    });
    if (gate.missing.length > 0) notReady += 1;
    if (sameList(order.docsRequired, gate.required) && sameList(order.docsMissing, gate.missing)) {
      unchanged += 1;
      continue;
    }
    actions.push({
      action: 'UPDATE_ORDER_DOC_GATE',
      pass: 'd',
      purpose: 'Cache what the required-document gate decided, so the board can colour the cell',
      id: String(order.id),
      docsRequired: gate.required,
      docsMissing: gate.missing,
      before: {
        docsRequired: Array.isArray(order.docsRequired) ? order.docsRequired : null,
        docsMissing: Array.isArray(order.docsMissing) ? order.docsMissing : null,
      },
    });
  }

  return { actions, unchanged, notReady };
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * @param {any} doc
 * @param {string} tableName
 * @returns {Promise<any[]>}
 */
export async function scanAll(doc, tableName) {
  const items = [];
  let startKey;
  do {
    try {
      const page = await doc.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') {
        throw new Error(`Table ${tableName} does not exist — has the Step E schema been deployed to this stack?`);
      }
      throw err;
    }
  } while (startKey);
  return items;
}

/**
 * Everything the four passes read, in one go. The ShipmentDocument table is allowed to be
 * missing: a plan is worth reviewing before the Step E schema is deployed, and an index that
 * does not exist yet is an empty one. `null` says so, and apply refuses it.
 * @param {any} doc
 * @param {string} suffix
 * @returns {Promise<Record<string, any[] | null>>}
 */
export async function readSource(doc, suffix) {
  const entries = await Promise.all(
    MODELS.filter((m) => m !== 'AuditLog').map(async (model) => {
      try {
        return [model, await scanAll(doc, `${model}-${suffix}`)];
      } catch (err) {
        if (model === 'ShipmentDocument' && /does not exist/.test(err.message)) return [model, null];
        throw err;
      }
    })
  );
  return Object.fromEntries(entries);
}

/**
 * Exactly the fields the four passes read, per row. Fingerprinting `updatedAt` instead would
 * invalidate the plan every time a tracking ping touched a load, which on a live stack means
 * never being able to apply one; fingerprinting what the passes actually look at invalidates
 * the plan when, and only when, it has stopped being true.
 * @param {Record<string, any[] | null>} source
 * @returns {Array<Record<string, unknown>>}
 */
export function sourceRowsOf(source) {
  const FIELDS = {
    Load: ['shipmentId', 'orderId', 'rateConfirmKey', 'createdAt'],
    Order: ['shipmentId', 'customerId', 'docsRequired', 'docsMissing'],
    LoadCarrier: ['loadId', 'shipmentId', 'status', 'rateConStatus'],
    Customer: ['requiredDocsForInvoice'],
    TmsSettings: ['defaultRequiredDocs', 'requiredCarrierUploadTypes'],
    DriverSubmission: ['loadId', 'driverId', 'podReviewStatus', 'combinedPodKey', 'referenceNumber', 'createdAt'],
    DriverSubmissionDoc: ['submissionId', 'driverId', 'kind', 's3Key', 'enhancedKey', 'fileName', 'contentType', 'byteSize', 'pageNumber', 'uploadedAt'],
  };
  const rows = [];
  for (const [model, fields] of Object.entries(FIELDS)) {
    for (const row of source[model] ?? []) {
      const entry = { model, id: String(row.id) };
      for (const field of fields) entry[field] = row[field] ?? null;
      rows.push(entry);
    }
  }
  return rows;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {Record<string, any[]>} input.source
 * @param {string} input.environment
 * @param {string} input.suffix
 */
export function buildDocumentPlan({ source, environment, suffix }) {
  const loadsById = new Map((source.Load ?? []).map((l) => [String(l.id), l]));
  const orderByShipmentId = new Map();
  for (const order of source.Order ?? []) {
    if (order.shipmentId && !orderByShipmentId.has(String(order.shipmentId))) {
      orderByShipmentId.set(String(order.shipmentId), order);
    }
  }
  const existingDocumentIds = new Set((source.ShipmentDocument ?? []).map((d) => String(d.id)));
  // Version numbering is per shipment + type + load, so the passes share one view of what each
  // shipment already has and extend it as they plan.
  const docsByShipment = new Map();
  for (const doc of source.ShipmentDocument ?? []) {
    const list = docsByShipment.get(String(doc.shipmentId)) ?? [];
    list.push(doc);
    docsByShipment.set(String(doc.shipmentId), list);
  }

  const podPass = planDriverPodRows({
    submissions: source.DriverSubmission ?? [],
    submissionDocs: source.DriverSubmissionDoc ?? [],
    loadsById,
    existingDocumentIds,
    docsByShipment,
  });
  const rateConPass = planLegacyRateConRows({
    loads: source.Load ?? [],
    orderByShipmentId,
    existingDocumentIds,
    docsByShipment,
  });
  const vocabularyPass = planRequiredDocRewrites({
    customers: source.Customer ?? [],
    settings: source.TmsSettings ?? [],
  });

  // The gate is computed over the index as it will be once (a) and (b) have landed: an order
  // whose only POD is one of these rows is complete, and saying otherwise would be a lie the
  // first person to open the board would have to chase.
  const settings = (source.TmsSettings ?? []).find((s) => String(s.id) === 'default') ?? (source.TmsSettings ?? [])[0] ?? null;
  const gatePass = planOrderGates({
    orders: source.Order ?? [],
    loads: source.Load ?? [],
    loadCarriers: source.LoadCarrier ?? [],
    customers: source.Customer ?? [],
    settings,
    documents: [
      ...(source.ShipmentDocument ?? []),
      ...podPass.actions.map((a) => a.item),
      ...rateConPass.actions.map((a) => a.item),
    ],
  });

  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: 'DriverSubmission + Load.rateConfirmKey + Customer/TmsSettings required docs + Order',
    sourceRows: sourceRowsOf(source),
    actions: [
      ...podPass.actions,
      ...rateConPass.actions,
      ...vocabularyPass.actions,
      ...gatePass.actions,
    ],
    reviewables: vocabularyPass.unrecognised.map((u) => ({
      kind: 'UNRECOGNISED_REQUIRED_DOC',
      reason: `${u.table} ${u.label} asks for documents the vocabulary does not know; kept on the record, cannot gate`,
      source: u,
    })),
    unresolved: [...podPass.skipped, ...rateConPass.skipped],
    summary: {
      passA: {
        approvedSubmissions: podPass.approved,
        rowsToCreate: podPass.actions.length,
        alreadyIndexed: podPass.alreadyIndexed,
        skipped: podPass.skipped.length,
      },
      passB: {
        loadsWithRateConKey: rateConPass.withKey,
        rowsToCreate: rateConPass.actions.length,
        alreadyIndexed: rateConPass.alreadyIndexed,
        skipped: rateConPass.skipped.length,
      },
      passC: {
        listsToRewrite: vocabularyPass.actions.length,
        alreadyTyped: vocabularyPass.alreadyTyped,
        recordsWithUnrecognised: vocabularyPass.unrecognised.length,
      },
      passD: {
        orders: (source.Order ?? []).length,
        ordersToUpdate: gatePass.actions.length,
        unchanged: gatePass.unchanged,
        ordersMissingDocuments: gatePass.notReady,
      },
      existingShipmentDocuments: existingDocumentIds.size,
      shipmentDocumentTableDeployed: source.ShipmentDocument != null,
    },
  });
}

/**
 * The review printout: what a person needs to decide whether to apply this.
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} plan
 * @returns {string}
 */
export function reviewText(plan) {
  const s = plan.summary;
  const lines = [
    summarize(plan),
    '',
    'Pass (a) driver-app PODs → drv:<submissionDocId> pointer rows',
    `  approved submissions read:   ${s.passA.approvedSubmissions}`,
    `  pointer rows to create:      ${s.passA.rowsToCreate}`,
    `  already indexed:             ${s.passA.alreadyIndexed}`,
    `  skipped (no load/shipment):  ${s.passA.skipped}`,
    '',
    'Pass (b) Load.rateConfirmKey → rck:<loadId> CUSTOMER_RATE_CON rows',
    `  loads carrying a rate con:   ${s.passB.loadsWithRateConKey}`,
    `  rows to create:              ${s.passB.rowsToCreate}`,
    `  already indexed:             ${s.passB.alreadyIndexed}`,
    `  skipped (no shipment/order): ${s.passB.skipped}`,
    '',
    'Pass (c) required documents → the Step E vocabulary',
    `  lists to rewrite:            ${s.passC.listsToRewrite}`,
    `  already typed:               ${s.passC.alreadyTyped}`,
    `  records with unknown text:   ${s.passC.recordsWithUnrecognised}`,
    '',
    'Pass (d) Order.docsRequired / docsMissing / docsCheckedAt',
    `  orders read:                 ${s.passD.orders}`,
    `  orders to update:            ${s.passD.ordersToUpdate}`,
    `  already correct:             ${s.passD.unchanged}`,
    `  orders missing a document:   ${s.passD.ordersMissingDocuments}`,
  ];

  if (!s.shipmentDocumentTableDeployed) {
    lines.push(
      '',
      'NOTE: the ShipmentDocument table does not exist in this stack yet, so the plan was',
      '      computed against an empty index. Deploy the Step E schema before applying.'
    );
  }

  if (plan.reviewables.length > 0) {
    lines.push('', 'Required-document text nobody can gate on — kept on the record, for Ryne:');
    for (const r of plan.reviewables) {
      lines.push(`  ${r.source.table} ${r.source.label} (${r.source.id}): ${r.source.values.map((v) => `"${v}"`).join(', ')}`);
    }
  } else {
    lines.push('', 'Every required-document string is in the vocabulary. Nothing for Ryne to decide.');
  }

  const bySkip = {};
  for (const u of plan.unresolved) bySkip[u.reason] = (bySkip[u.reason] ?? 0) + 1;
  if (plan.unresolved.length > 0) {
    lines.push('', 'Paperwork left where it is (no row invented):');
    for (const [reason, count] of Object.entries(bySkip).sort()) lines.push(`  ${reason}: ${count}`);
  }

  return lines.join('\n');
}

// ── Apply ────────────────────────────────────────────────────────────────────

/**
 * One audit row per write, the same way the Lambdas do it. Best effort: a backfilled row must
 * not be reported as failed because the history table refused a line.
 * @param {any} doc
 * @param {string} table
 * @param {string} entityType
 * @param {string} entityId
 * @param {string} action
 * @param {Record<string, unknown>} changes
 */
async function writeAudit(doc, table, entityType, entityId, action, changes) {
  const now = new Date().toISOString();
  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: {
        id: randomUUID(),
        __typename: 'AuditLog',
        entityType,
        entityId,
        action,
        user: MIGRATION_USER,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      },
    }));
  } catch (err) {
    console.warn(`audit log write failed for ${entityType} ${entityId}: ${err.message}`);
  }
}

/**
 * The condition that makes an update replay-safe: the stored value must still be the one the
 * plan was computed from. A field somebody edited after the plan was written is left alone and
 * reported, rather than quietly reverted to what the plan remembers.
 * @param {string} name
 * @param {unknown[] | null | undefined} before
 * @param {string} slot
 * @returns {{expression: string, values: Record<string, unknown>}}
 */
function unchangedSince(name, before, slot) {
  if (before == null) return { expression: `attribute_not_exists(${name})`, values: {} };
  return { expression: `${name} = :${slot}`, values: { [`:${slot}`]: before } };
}

/**
 * @param {object} input
 * @param {any} input.doc
 * @param {import('./lib/tmsPlan.mjs').TmsPlan} input.plan
 * @param {string} input.suffix
 */
export async function applyDocumentPlan({ doc, plan, suffix }) {
  const table = (model) => `${model}-${suffix}`;
  const auditTable = table('AuditLog');
  const report = {
    documentsCreated: 0,
    documentsAlreadyThere: 0,
    listsRewritten: 0,
    listsAlreadyCurrent: 0,
    ordersUpdated: 0,
    ordersAlreadyCurrent: 0,
    failures: [],
  };

  for (const entry of plan.actions) {
    try {
      if (entry.action === 'PUT_SHIPMENT_DOCUMENT') {
        const now = new Date().toISOString();
        try {
          await doc.send(new PutCommand({
            TableName: table('ShipmentDocument'),
            Item: { ...entry.item, createdAt: now, updatedAt: now },
            // The deterministic id plus this condition is what makes a re-run free: the row
            // that is already there was written by this same script and is already right.
            ConditionExpression: 'attribute_not_exists(id)',
          }));
          report.documentsCreated += 1;
          await writeAudit(doc, auditTable, 'ShipmentDocument', entry.item.id, 'BACKFILL_DOCUMENT', {
            pass: entry.pass, type: entry.item.type, source: entry.item.source, s3Key: entry.item.s3Key,
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          report.documentsAlreadyThere += 1;
        }
        continue;
      }

      if (entry.action === 'UPDATE_REQUIRED_DOCS') {
        const guard = unchangedSince('#f', entry.before, 'before');
        try {
          await doc.send(new UpdateCommand({
            TableName: table(entry.table),
            Key: { id: entry.id },
            UpdateExpression: 'SET #f = :after, updatedAt = :now',
            ConditionExpression: `attribute_exists(id) AND ${guard.expression}`,
            ExpressionAttributeNames: { '#f': entry.field },
            ExpressionAttributeValues: { ':after': entry.after, ':now': new Date().toISOString(), ...guard.values },
          }));
          report.listsRewritten += 1;
          await writeAudit(doc, auditTable, entry.table, entry.id, 'BACKFILL_REQUIRED_DOCS', {
            field: entry.field, before: entry.before, after: entry.after,
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          report.listsAlreadyCurrent += 1;
        }
        continue;
      }

      if (entry.action === 'UPDATE_ORDER_DOC_GATE') {
        const now = new Date().toISOString();
        const requiredGuard = unchangedSince('docsRequired', entry.before.docsRequired, 'beforeRequired');
        const missingGuard = unchangedSince('docsMissing', entry.before.docsMissing, 'beforeMissing');
        try {
          await doc.send(new UpdateCommand({
            TableName: table('Order'),
            Key: { id: entry.id },
            UpdateExpression:
              'SET docsRequired = :req, docsMissing = :missing, docsCheckedAt = :now, updatedAt = :now, updatedBy = :user',
            ConditionExpression: `attribute_exists(id) AND ${requiredGuard.expression} AND ${missingGuard.expression}`,
            ExpressionAttributeValues: {
              ':req': entry.docsRequired,
              ':missing': entry.docsMissing,
              ':now': now,
              ':user': MIGRATION_USER,
              ...requiredGuard.values,
              ...missingGuard.values,
            },
          }));
          report.ordersUpdated += 1;
          await writeAudit(doc, auditTable, 'Order', entry.id, 'BACKFILL_DOC_GATE', {
            docsRequired: entry.docsRequired, docsMissing: entry.docsMissing, before: entry.before,
          });
        } catch (err) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
          // The gate was recomputed by the Lambda, or a person edited the order, since the
          // plan was written. Whatever is there now is newer than this plan.
          report.ordersAlreadyCurrent += 1;
        }
        continue;
      }

      throw new Error(`Unknown action ${entry.action}`);
    } catch (err) {
      report.failures.push({ action: entry.action, id: entry.id ?? entry.item?.id, error: err.message });
    }
  }

  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseTmsArgs({ suffix: { type: 'string' }, region: { type: 'string' } });
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { suffix, environment } = resolveTarget(args.values.suffix);
  const region = args.values.region ?? REGION_DEFAULT;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const source = await readSource(doc, suffix);

  if (!args.values.apply) {
    const plan = buildDocumentPlan({ source, environment, suffix });
    console.log(reviewText(plan));
    if (args.values.plan) {
      const planPath = resolve(process.cwd(), args.values.plan);
      savePlan(plan, planPath);
      console.log(`\nPlan written to ${args.values.plan} — review it, then re-run with --apply --plan ${args.values.plan}`);
    } else {
      console.log('\nDry run: nothing was written. Pass --plan <path> to save this plan, then --apply it.');
    }
    process.exit(0);
  }

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying: apply replays a plan a person has read');
  }
  if (source.ShipmentDocument == null) {
    throw new Error(
      `Table ShipmentDocument-${suffix} does not exist: deploy the Step E schema to this stack before applying.`
    );
  }
  const plan = loadPlan(resolve(process.cwd(), args.values.plan));
  validatePlan(plan, {
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceRows: sourceRowsOf(source),
  });

  const report = await applyDocumentPlan({ doc, plan, suffix });
  console.log(JSON.stringify({ environment, suffix, ...report }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
