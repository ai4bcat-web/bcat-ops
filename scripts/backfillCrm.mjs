#!/usr/bin/env node
/**
 * Seed the CRM tables from the customers we already have (Step AB §5.3).
 *
 * Creates, for every existing Customer, a CrmAccount row (the stage is the Customer's own
 * `status`, so existing customers read as CUSTOMER / ACTIVE and prospects keep their lead
 * stage); a CrmContact for every e-mail address on `Customer.contacts`, `billingEmail`
 * and `contactEmail` that belongs to exactly one customer; and a CrmDomain for every
 * registrable domain seen on those addresses or on `website`. A domain on two or more
 * customers is written `conflict: true` with the ids (3PLs, auditors, portals); free-mail,
 * shared-service (EDI, Coupa, ...) and our own domains are never claimed.
 *
 * Nothing is ever overwritten: every write is `attribute_not_exists(id)`, so a manual
 * claim survives and a second run creates nothing. Dry run is the default and writes
 * nothing; `--apply` writes. Output is counts only — no addresses, no names.
 *
 * Dev by default: the production table suffix is refused before a single read, except through
 * the shared gate (`--target prod`, scripts/lib/prodGate.mjs).
 *
 *   node scripts/backfillCrm.mjs               # dry run, counts only
 *   node scripts/backfillCrm.mjs --apply
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { parseTmsArgs } from './lib/tmsConfig.mjs';
import { PROD_GATE_OPTIONS, PROD_GATE_USAGE, requireProd, assertWritableSuffix } from './lib/prodGate.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';

export const REGION_DEFAULT = 'us-east-1';
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
export const MIGRATION_USER = 'migration:backfillCrm';

const USAGE = `
Usage: node scripts/backfillCrm.mjs [options]

  --help, -h     Show this offline help.
  --suffix <s>   DynamoDB table suffix (default ${DEV_TABLE_SUFFIX}); production only via --target prod.
  --region <r>   AWS region (default ${REGION_DEFAULT}).
  --apply        Write the rows. Without it nothing is written (dry run).

Creates CrmAccount / CrmContact / CrmDomain rows for existing customers. Never overwrites
a row, so it is safe to re-run. Prints counts only.

${PROD_GATE_USAGE}
`;

/** @param {string | undefined} value */
export function resolveTarget(value) {
  const suffix = (value ?? process.env.TABLE_SUFFIX ?? DEV_TABLE_SUFFIX).trim();
  if (!suffix) throw new Error('--suffix <tableSuffix> cannot be empty');
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(
      `Refusing to run against production tables (${suffix}): the CRM backfill is a dev-only build without --target prod. ` +
        `Point it at the dev suffix (${DEV_TABLE_SUFFIX}).`
    );
  }
  return { suffix, environment: suffix === DEV_TABLE_SUFFIX ? 'dev' : suffix };
}

// ── Domain rules ─────────────────────────────────────────────────────────────
//
// A mirror of src/lib/crm/{domains,backfill}.ts: plain Node cannot import TypeScript.
// backfillCrm.test.mjs pins this file to the TypeScript planner over a fixture, so the
// two cannot drift apart quietly.

const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com',
  'live.com', 'msn.com', 'comcast.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
  'yandex.com', 'ymail.com',
  'googlemail.com', 'att.net', 'sbcglobal.net', 'verizon.net', 'cox.net', 'bellsouth.net',
  'earthlink.net', 'rocketmail.com', 'hey.com',
]);
const TWO_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.mx',
  'co.in', 'com.br', 'com.ar', 'co.jp', 'co.za', 'com.cn', 'com.tr', 'com.sg', 'com.hk',
]);
const SHARED = new Set([
  'amazon.com', 'coupa.com', 'ariba.com', 'jaggaer.com', 'tungsten-network.com',
  'sps-commerce.com', 'spscommerce.com', 'truckstop.com', 'dat.com', 'echo.com',
  'docusign.net', 'quickbooks.com', 'intuit.com', 'google.com', 'microsoft.com',
]);
const OWN = ['bcatcorp.com'];

/** @param {unknown} raw */
export function normalizeAddress(raw) {
  let value = typeof raw === 'string' ? raw.trim() : '';
  const angle = value.match(/<([^<>]+)>\s*$/);
  if (angle) value = angle[1];
  value = value.trim().toLowerCase().replace(/^mailto:/, '');
  return /^[^\s@<>,;]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value) ? value : '';
}

/** @param {unknown} input */
export function registrableDomain(input) {
  let host = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!host) return '';
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#:\s>]/)[0];
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9-]+$/.test(l))) return '';
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

/** @param {string} domain */
export function isClaimableDomain(domain) {
  const d = domain.trim().toLowerCase();
  return !!d && !FREEMAIL.has(d) && !OWN.includes(d) && !SHARED.has(d) && !/^edi[a-z0-9-]*\./.test(d);
}

/** @param {{accountOwnerIds?: string[] | null, defaultSalesRepId?: string | null}} c */
function ownerOf(c) {
  const primary = (c.accountOwnerIds ?? []).find((id) => typeof id === 'string' && id.trim() !== '');
  if (primary) return primary;
  return typeof c.defaultSalesRepId === 'string' && c.defaultSalesRepId.trim() ? c.defaultSalesRepId : null;
}

/** @param {unknown} raw */
function addressesIn(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(/[;,\n]/).map((p) => normalizeAddress(p)).filter(Boolean);
}

/**
 * @param {any[]} customers Customer rows (`contacts` already parsed).
 * @param {{accountIds: string[], contactIds: string[], domainIds: string[]}} existing
 */
export function planCrmBackfill(customers, existing) {
  const haveAccount = new Set(existing.accountIds);
  const haveContact = new Set(existing.contactIds);
  const haveDomain = new Set(existing.domainIds);
  const contactOwners = new Map();
  const domainOwners = new Map();
  let skippedIneligible = 0;

  const noteDomain = (domain, customerId, fromEmail) => {
    if (!domain) return;
    if (!isClaimableDomain(domain)) {
      skippedIneligible += 1;
      return;
    }
    const entry = domainOwners.get(domain) ?? { customers: new Set(), fromEmail: false };
    entry.customers.add(customerId);
    entry.fromEmail = entry.fromEmail || fromEmail;
    domainOwners.set(domain, entry);
  };

  for (const customer of customers) {
    const emails = [];
    if (Array.isArray(customer.contacts)) {
      for (const raw of customer.contacts) {
        const email = normalizeAddress(raw?.email);
        if (email) emails.push({ email, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null });
      }
    }
    for (const email of [...addressesIn(customer.billingEmail), ...addressesIn(customer.contactEmail)]) {
      emails.push({ email, name: null });
    }
    for (const { email, name } of emails) {
      const entry = contactOwners.get(email) ?? { customers: new Set(), name: null };
      entry.customers.add(customer.id);
      entry.name = entry.name ?? name;
      contactOwners.set(email, entry);
      noteDomain(registrableDomain(email.slice(email.lastIndexOf('@') + 1)), customer.id, true);
    }
    if (customer.website) noteDomain(registrableDomain(customer.website), customer.id, false);
  }

  const ownerById = new Map(customers.map((c) => [c.id, ownerOf(c)]));
  const contacts = [];
  let shared = 0;
  for (const [id, entry] of contactOwners) {
    if (entry.customers.size > 1) {
      shared += 1;
      continue;
    }
    if (haveContact.has(id)) continue;
    const customerId = [...entry.customers][0];
    contacts.push({ id, customerId, name: entry.name, ownerId: ownerById.get(customerId) ?? null, source: 'BACKFILL' });
  }

  const domains = [];
  for (const [id, entry] of domainOwners) {
    if (haveDomain.has(id)) continue;
    const ids = [...entry.customers];
    const conflict = ids.length > 1;
    domains.push({
      id,
      customerId: conflict ? null : ids[0],
      source: entry.fromEmail ? 'BACKFILL' : 'WEBSITE',
      conflict,
      conflictCustomerIds: conflict ? ids : [],
    });
  }

  const accounts = customers.filter((c) => !haveAccount.has(c.id)).map((c) => c.id);
  return {
    accounts,
    contacts,
    domains,
    stats: {
      customers: customers.length,
      accountsToCreate: accounts.length,
      contactsToCreate: contacts.length,
      contactsSharedBetweenCustomers: shared,
      domainsToCreate: domains.length,
      domainsConflicted: domains.filter((d) => d.conflict).length,
      domainsSkippedIneligible: skippedIneligible,
    },
  };
}

// ── Read / apply ─────────────────────────────────────────────────────────────

async function scanAll(doc, tableName, projection) {
  const items = [];
  let startKey;
  do {
    try {
      const page = await doc.send(new ScanCommand({ TableName: tableName, ProjectionExpression: projection, ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') {
        throw new Error(`Table ${tableName} does not exist — has the schema been deployed to this stack?`);
      }
      throw err;
    }
  } while (startKey);
  return items;
}

function parseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** @param {any} doc @param {string} suffix */
export async function readSource(doc, suffix) {
  const [customers, accounts, contacts, domains] = await Promise.all([
    scanAll(doc, `Customer-${suffix}`, 'id, contacts, billingEmail, contactEmail, website, accountOwnerIds, defaultSalesRepId'),
    scanAll(doc, `CrmAccount-${suffix}`, 'id'),
    scanAll(doc, `CrmContact-${suffix}`, 'id'),
    scanAll(doc, `CrmDomain-${suffix}`, 'id'),
  ]);
  return {
    customers: customers.map((c) => ({ ...c, contacts: parseJson(c.contacts) })),
    existing: { accountIds: accounts.map((r) => r.id), contactIds: contacts.map((r) => r.id), domainIds: domains.map((r) => r.id) },
  };
}

/** @param {any} doc @param {ReturnType<typeof planCrmBackfill>} plan @param {string} suffix */
export async function applyPlan({ doc, plan, suffix }) {
  assertWritableSuffix(suffix, 'CRM rows');
  const now = new Date().toISOString();
  const created = { accounts: 0, contacts: 0, domains: 0 };
  const put = async (model, item) => {
    try {
      await doc.send(new PutCommand({
        TableName: `${model}-${suffix}`,
        Item: { ...item, __typename: model, version: 0, createdAt: now, updatedAt: now },
        ConditionExpression: 'attribute_not_exists(id)',
      }));
      return true;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  };
  for (const id of plan.accounts) {
    if (await put('CrmAccount', { id, openTaskCount: 0, updatedBy: MIGRATION_USER })) created.accounts += 1;
  }
  for (const c of plan.contacts) {
    const item = { id: c.id, customerId: c.customerId, source: c.source, status: 'ACTIVE', createdBy: MIGRATION_USER, updatedBy: MIGRATION_USER };
    if (c.name) item.name = c.name;
    if (c.ownerId) item.ownerId = c.ownerId;
    if (await put('CrmContact', item)) created.contacts += 1;
  }
  for (const d of plan.domains) {
    const item = { id: d.id, source: d.source, conflict: d.conflict, conflictCustomerIds: d.conflictCustomerIds, claimedBy: MIGRATION_USER, claimedAt: now };
    if (d.customerId) item.customerId = d.customerId;
    if (await put('CrmDomain', item)) created.domains += 1;
  }
  try {
    await doc.send(new PutCommand({
      TableName: `AuditLog-${suffix}`,
      Item: {
        id: randomUUID(), __typename: 'AuditLog', entityType: 'CRM_BACKFILL', entityId: 'crm', action: 'BACKFILL',
        user: MIGRATION_USER, changes: JSON.stringify({ created, stats: plan.stats }), createdAt: now, updatedAt: now,
      },
    }));
  } catch (err) {
    console.warn(`audit log write failed: ${err.message}`);
  }
  return created;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseTmsArgs({ suffix: { type: 'string' }, region: { type: 'string' }, ...PROD_GATE_OPTIONS });
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const prod = await requireProd({ script: 'backfillCrm', values: args.values, tables: PROD_WRITE_SETS.backfillCrm.models });
  const { suffix, environment } = prod ?? resolveTarget(args.values.suffix);
  const apply = prod ? prod.apply : args.values.apply;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.values.region ?? REGION_DEFAULT }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const { customers, existing } = await readSource(doc, suffix);
  const plan = planCrmBackfill(customers, existing);
  console.log(JSON.stringify({ environment, suffix, mode: apply ? 'apply' : 'dry-run', stats: plan.stats }, null, 2));
  if (!apply) {
    console.log('\nDry run: nothing was written. Re-run with --apply to create these rows.');
    return;
  }
  console.log(JSON.stringify({ created: await applyPlan({ doc, plan, suffix }) }, null, 2));
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
