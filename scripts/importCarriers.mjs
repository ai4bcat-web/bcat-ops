#!/usr/bin/env node
/**
 * Import Carrier / CarrierContact rows from an Aljex or Highway export.
 *
 * PRODUCTION CUTOVER SCRIPT — DO NOT RUN AGAINST DEV.
 * This exists to seed the carrier directory once, at cutover, from the export the
 * office already maintains. Running it against the shared dev backend fills the
 * live directory with hundreds of PENDING carriers that somebody then has to
 * delete by hand, and every one of them is a real company name.
 *
 * Non-production targets use the same guards the other TMS migrations use:
 * `loadAmplifyOutputs` refuses the repo-root (production) outputs file and
 * `detectMode`/`requireApplyEnv` refuse anything but an explicitly named
 * isolated target. The production cutover itself is NOT blocked here, because a
 * blocked cutover only means somebody edits the guard out under time pressure on
 * the day. It is made deliberately awkward instead: a production apply needs
 * `--apply`, `--env production`, the production outputs file named explicitly on
 * the command line, a reviewed plan file, and `BCAT_CUTOVER_CONFIRM` set to that
 * plan's fingerprint. Miss any one of them and the run refuses, naming what is
 * missing. A production DRY RUN needs none of it and stays the default.
 *
 * Every write goes through the tmsCarrierActions Lambda — the carrier tables are
 * Lambda-written and a migration script is not an exception to that. This script
 * decides WHICH rows are importable, maps the export columns onto the Lambda's
 * input shape, records a reviewable plan, and reports what came back.
 *
 * Nothing is guessed. A row with no usable name is skipped, an unrecognised
 * carrier type is skipped, an unparseable date is dropped and listed for review,
 * and no carrier is ever imported as anything but PENDING: the vetting that moves
 * a carrier to ACTIVE is a decision a person makes in the app.
 *
 * Idempotent: apply resolves each planned carrier against the directory by
 * normalized name, MC and DOT first, and skips the ones that already exist, so an
 * interrupted run can simply be run again.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import { parseTmsArgs, loadAmplifyOutputs, detectMode } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan, summarize } from './lib/tmsPlan.mjs';
import { normalizeCustomerName } from './lib/tmsNormalize.mjs';
import { decimalToCents } from './lib/tmsMoney.mjs';

/**
 * Environment names that mean the live backend. `requireApplyEnv` blocks these,
 * so a production apply takes the explicit cutover path below instead.
 */
export const PRODUCTION_ENVS = ['prod', 'production'];

/** The environment variable that has to carry the reviewed plan's fingerprint. */
export const CUTOVER_CONFIRM_VAR = 'BCAT_CUTOVER_CONFIRM';

const USAGE = `
Usage: node scripts/importCarriers.mjs --input <csv-or-json> --outputs <path> [options]

Options:
  --help, -h        Show this offline help.
  --input <path>    Required: Aljex/Highway carrier export (.csv or .json).
  --outputs <path>  Required: path to amplify_outputs.json.
  --plan <path>     (dry-run) write plan file; (apply) read plan file.
  --env <target>    Required with --apply: test / sandbox / local, or production
                    under the cutover conditions below.
  --apply           Apply the reviewed plan.

Dry run (the default, every target including production) reads the export offline,
maps every importable row to an UPSERT_CARRIER (status PENDING, with its insurance
policies) plus UPSERT_CONTACT calls, and writes the result as a JSON plan. Apply
validates the plan's fingerprint, environment and endpoint, then replays the same
calls through the tmsCarrierActions mutation.

Applying to test / sandbox / local: --outputs must NOT be the repo-root
amplify_outputs.json, which is the production backend.

Applying to production (the one-time cutover) requires all four of:
  1. --apply --env production (or --env prod)
  2. --outputs <path to the production amplify_outputs.json>, named explicitly
  3. --plan <path to the reviewed dry-run plan>
  4. ${CUTOVER_CONFIRM_VAR}=<the "fingerprint" field of that plan file>
Anything missing or mismatched refuses and says which of the four it was.

  node scripts/importCarriers.mjs --input carriers.csv \\
    --outputs ./amplify_outputs.json --env production --plan plans/carriers.json
  # read the "fingerprint" field out of plans/carriers.json, then:
  ${CUTOVER_CONFIRM_VAR}=sha256:... node scripts/importCarriers.mjs \\
    --input carriers.csv --outputs ./amplify_outputs.json \\
    --env production --plan plans/carriers.json --apply

This is the production cutover importer. It must never be pointed at dev: a dev
run fills the shared live directory with hundreds of real company names in PENDING
that somebody then deletes by hand.
`;

/** Carrier types the Lambda accepts. Anything else in the export is a skip, not a guess. */
export const CARRIER_TYPES = ['TL', 'LTL', 'CARTAGE', 'LINEHAUL', 'AIR', 'OCEAN', 'RAIL', 'AGENT'];

/** Export spellings seen in Aljex/Highway exports, mapped onto the enum. */
const CARRIER_TYPE_ALIASES = new Map([
  ['tl', 'TL'], ['truckload', 'TL'], ['full truckload', 'TL'], ['ftl', 'TL'], ['van', 'TL'],
  ['ltl', 'LTL'], ['less than truckload', 'LTL'], ['partial', 'LTL'],
  ['cartage', 'CARTAGE'], ['drayage', 'CARTAGE'], ['dray', 'CARTAGE'], ['local', 'CARTAGE'],
  ['linehaul', 'LINEHAUL'], ['line haul', 'LINEHAUL'],
  ['air', 'AIR'], ['air freight', 'AIR'],
  ['ocean', 'OCEAN'], ['steamship', 'OCEAN'],
  ['rail', 'RAIL'], ['intermodal', 'RAIL'],
  ['agent', 'AGENT'], ['broker', 'AGENT'],
]);

const EQUIPMENT_ALIASES = new Map([
  ['container', 'CONTAINER'], ['intermodal', 'CONTAINER'],
  ['flatbed', 'FLATBED'], ['flat', 'FLATBED'], ['stepdeck', 'FLATBED'], ['step deck', 'FLATBED'],
  ['power only', 'POWER_ONLY'], ['power_only', 'POWER_ONLY'],
  ['reefer', 'REEFER'], ['refrigerated', 'REEFER'], ['temp controlled', 'REEFER'],
  ['specialized', 'SPECIALIZED'], ['heavy haul', 'SPECIALIZED'], ['oversize', 'SPECIALIZED'],
  ['tanker', 'TANKER'], ['tank', 'TANKER'],
  ['van', 'VAN'], ['dry van', 'VAN'], ['dryvan', 'VAN'],
]);

const AUTHORITY_STATUSES = new Map([
  ['active', 'ACTIVE'], ['authorized', 'ACTIVE'], ['authorized for property', 'ACTIVE'],
  ['inactive', 'INACTIVE'], ['not authorized', 'INACTIVE'], ['revoked', 'INACTIVE'],
  ['none', 'NONE'], ['unknown', 'UNKNOWN'],
]);

const SAFETY_RATINGS = new Map([
  ['satisfactory', 'SATISFACTORY'],
  ['conditional', 'CONDITIONAL'],
  ['unsatisfactory', 'UNSATISFACTORY'],
  ['none', 'NONE'], ['not rated', 'NONE'], ['unrated', 'NONE'],
  ['unknown', 'UNKNOWN'],
]);

const COMPLIANCE_STATUSES = new Map([
  ['pass', 'PASS'], ['passed', 'PASS'], ['approved', 'PASS'],
  ['fail', 'FAIL'], ['failed', 'FAIL'], ['rejected', 'FAIL'],
  ['incomplete', 'INCOMPLETE'], ['pending', 'INCOMPLETE'],
  ['partial', 'PARTIAL'],
  ['none', 'NONE'], ['not checked', 'NONE'],
]);

/**
 * Export column headers, normalised, per target field. First match wins, so the
 * most specific spelling is listed first.
 */
const HEADER_ALIASES = {
  name: ['carrier name', 'legal name', 'company name', 'company', 'name', 'carrier'],
  dbaName: ['dba name', 'dba', 'doing business as'],
  type: ['carrier type', 'mode', 'type'],
  mcNumber: ['mc number', 'mc #', 'mc#', 'mc', 'docket number', 'docket'],
  dotNumber: ['usdot number', 'us dot', 'usdot', 'dot number', 'dot #', 'dot#', 'dot'],
  scac: ['scac code', 'scac'],
  einNumber: ['ein', 'fein', 'tax id', 'federal tax id'],
  phone: ['carrier phone', 'main phone', 'phone number', 'phone'],
  email: ['carrier email', 'main email', 'email address', 'email'],
  website: ['website', 'web site', 'url'],
  street: ['address 1', 'address1', 'street address', 'physical address', 'address'],
  city: ['city', 'physical city'],
  state: ['state', 'physical state', 'st'],
  zip: ['zip code', 'postal code', 'zip'],
  country: ['country'],
  authorityStatus: ['operating status', 'authority status', 'authority'],
  authorityGrantedAt: ['mc granted date', 'authority granted', 'authority date'],
  safetyRating: ['safety rating', 'fmcsa rating'],
  safetyRatingAt: ['safety rating date', 'rating date'],
  equipment: ['equipment types', 'equipment type', 'trailer types', 'equipment'],
  powerUnits: ['power units', 'trucks', 'tractors'],
  trailerCount: ['trailers', 'trailer count'],
  driverCount: ['drivers', 'driver count'],
  paymentTermsDays: ['payment terms days', 'payment terms', 'terms days', 'terms'],
  highwayStatus: ['highway status', 'highway'],
  rmisStatus: ['rmis status', 'rmis'],
  mcpStatus: ['mycarrierpackets status', 'mcp status', 'mycarrierpackets'],
  internalNotes: ['internal notes', 'notes', 'comments'],
  dispatcherName: ['dispatch contact', 'dispatcher name', 'dispatcher'],
  dispatcherPhone: ['dispatch phone', 'dispatcher phone'],
  dispatcherEmail: ['dispatch email', 'dispatcher email'],
  contactName: ['primary contact', 'contact name', 'contact'],
  contactPhone: ['contact phone'],
  contactEmail: ['contact email'],
  accountingName: ['accounting contact', 'billing contact'],
  accountingPhone: ['accounting phone', 'billing phone'],
  accountingEmail: ['accounting email', 'billing email'],
  autoLimit: ['auto liability limit', 'auto liability', 'liability limit'],
  autoExpires: ['auto liability expiration', 'auto liability expires', 'liability expiration'],
  autoCompany: ['auto liability carrier', 'liability insurance company'],
  autoPolicy: ['auto liability policy', 'liability policy number'],
  cargoLimit: ['cargo limit', 'cargo insurance limit', 'cargo insurance'],
  cargoExpires: ['cargo expiration', 'cargo expires', 'cargo insurance expiration'],
  cargoCompany: ['cargo carrier', 'cargo insurance company'],
  cargoPolicy: ['cargo policy', 'cargo policy number'],
  cargoDeductible: ['cargo deductible'],
  generalLimit: ['general liability limit', 'general liability'],
  generalExpires: ['general liability expiration', 'general liability expires'],
};

/**
 * Split a CSV document into rows, honouring quoted fields, embedded commas and
 * newlines, and doubled quotes. Returns raw cell arrays; headers are row 0.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Lower-case, collapse punctuation and whitespace in a header cell so
 * "MC #", "mc_number" and "MC Number" all land on the same alias.
 * @param {string} header
 * @returns {string}
 */
export function normalizeHeader(header) {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn CSV cells into objects keyed by normalised header.
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cells) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i]) continue;
      obj[headers[i]] = (cells[i] ?? '').trim();
    }
    return obj;
  });
}

/**
 * Read the export. `.json` may be either a bare array or `{ carriers: [...] }`;
 * anything else is parsed as CSV.
 * @param {string} path
 * @returns {{rows: Array<Record<string, string>>, format: 'json' | 'csv'}}
 */
export function readCarrierExport(path) {
  const text = readFileSync(resolve(process.cwd(), path), 'utf8');
  if (path.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.carriers) ? parsed.carriers : [];
    const rows = list.map((row) => {
      const obj = {};
      for (const [key, value] of Object.entries(row ?? {})) {
        obj[normalizeHeader(key)] = value == null ? '' : String(value).trim();
      }
      return obj;
    });
    return { rows, format: 'json' };
  }
  return { rows: parseCsv(text), format: 'csv' };
}

/**
 * First non-empty value among a field's header aliases.
 * @param {Record<string, string>} row
 * @param {string} field
 * @returns {string}
 */
export function pickField(row, field) {
  for (const alias of HEADER_ALIASES[field] ?? []) {
    const value = row[alias];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

/**
 * Map an export type spelling onto the CarrierType enum. Empty input returns
 * null (the caller defaults it and flags it for review); an unrecognised value
 * returns undefined so the row can be skipped rather than guessed at.
 * @param {string} raw
 * @returns {string | null | undefined}
 */
export function normalizeCarrierType(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (CARRIER_TYPES.includes(upper)) return upper;
  return CARRIER_TYPE_ALIASES.get(value.toLowerCase());
}

/**
 * Map a comma/slash/pipe separated equipment column onto the enum, dropping
 * anything that does not map.
 * @param {string} raw
 * @returns {string[]}
 */
export function normalizeEquipment(raw) {
  const tokens = String(raw ?? '')
    .split(/[,;/|]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const out = [];
  for (const token of tokens) {
    const mapped = EQUIPMENT_ALIASES.get(token);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Digits only, so "MC-123456" and "MC 123456" are the same docket.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeDocket(raw) {
  return String(raw ?? '').replace(/\D+/g, '');
}

/**
 * Parse an export date (`YYYY-MM-DD`, `M/D/YYYY`, `MM/DD/YY`) as UTC midnight.
 * Returns null when the value is absent or unreadable; the caller decides
 * whether that is a skip or a review note.
 * @param {string} raw
 * @returns {string | null}
 */
export function parseExportDate(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return isoUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(value);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return isoUtc(year, Number(us[1]), Number(us[2]));
  }
  return null;
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string | null}
 */
function isoUtc(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== month - 1) return null;
  return date.toISOString();
}

/**
 * Parse an insurance limit ("$1,000,000", "1000000", "1,000,000.00") to integer
 * cents through the money helper, so no float ever touches a money field.
 * @param {string} raw
 * @returns {number | null}
 */
export function parseLimitCents(raw) {
  const value = String(raw ?? '').replace(/[$,\s]/g, '').trim();
  if (!value) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [dollars, cents = ''] = value.split('.');
  const amount = decimalToCents(`${dollars}.${cents.padEnd(2, '0')}`);
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
export function parseCount(raw) {
  const value = String(raw ?? '').replace(/[,\s]/g, '').trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Build the insurance policies a row actually documents. A policy is only
 * created when the export gives a limit or an expiration; `issues` collects the
 * dates that could not be read so the reviewer sees them in the plan.
 * @param {Record<string, string>} row
 * @returns {{policies: any[], issues: string[]}}
 */
export function buildInsurancePolicies(row) {
  const specs = [
    { type: 'AUTO_LIABILITY', limit: 'autoLimit', expires: 'autoExpires', company: 'autoCompany', policy: 'autoPolicy' },
    { type: 'CARGO', limit: 'cargoLimit', expires: 'cargoExpires', company: 'cargoCompany', policy: 'cargoPolicy', deductible: 'cargoDeductible' },
    { type: 'GENERAL_LIABILITY', limit: 'generalLimit', expires: 'generalExpires' },
  ];
  const policies = [];
  const issues = [];

  for (const spec of specs) {
    const rawLimit = pickField(row, spec.limit);
    const rawExpires = pickField(row, spec.expires);
    if (!rawLimit && !rawExpires) continue;

    const limitCents = parseLimitCents(rawLimit);
    if (rawLimit && limitCents === null) issues.push(`${spec.type} limit "${rawLimit}" is unreadable`);
    const expiresAt = parseExportDate(rawExpires);
    if (rawExpires && !expiresAt) issues.push(`${spec.type} expiration "${rawExpires}" is unreadable`);

    // A policy row with neither a readable limit nor a readable expiry would read
    // as current, unlimited coverage in the booking gates. Refuse it and say so.
    if (limitCents === null && !expiresAt) {
      issues.push(`${spec.type} policy not imported: neither limit nor expiration could be read`);
      continue;
    }

    const policy = { type: spec.type };
    if (limitCents !== null) policy.limitCents = limitCents;
    if (expiresAt) policy.expiresAt = expiresAt;
    if (spec.company) {
      const company = pickField(row, spec.company);
      if (company) policy.company = company;
    }
    if (spec.policy) {
      const number = pickField(row, spec.policy);
      if (number) policy.policyNumber = number;
    }
    if (spec.deductible) {
      const deductible = parseLimitCents(pickField(row, spec.deductible));
      if (deductible !== null) policy.deductibleCents = deductible;
    }
    policies.push(policy);
  }

  return { policies, issues };
}

/**
 * Contacts the export names outright. The dispatch contact is the primary and
 * the rate-con recipient; a contact with neither phone nor email is not worth a row.
 * @param {Record<string, string>} row
 * @returns {any[]}
 */
export function buildContacts(row) {
  const specs = [
    { name: 'dispatcherName', phone: 'dispatcherPhone', email: 'dispatcherEmail', types: ['DISPATCH'], isPrimary: true, rateConRecipient: true },
    { name: 'contactName', phone: 'contactPhone', email: 'contactEmail', types: ['MANAGER'], isPrimary: false, rateConRecipient: false },
    { name: 'accountingName', phone: 'accountingPhone', email: 'accountingEmail', types: ['ACCOUNTING'], isPrimary: false, rateConRecipient: false },
  ];
  const contacts = [];
  const seen = new Set();

  for (const spec of specs) {
    const name = pickField(row, spec.name);
    const phone = pickField(row, spec.phone);
    const email = pickField(row, spec.email);
    if (!name || (!phone && !email)) continue;
    const key = `${name.toLowerCase()}|${email.toLowerCase()}|${phone}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const contact = { name, types: spec.types, active: true, isPrimary: spec.isPrimary, rateConRecipient: spec.rateConRecipient };
    if (phone) contact.phone = phone;
    if (email) contact.email = email;
    contacts.push(contact);
  }

  return contacts;
}

/**
 * Map one export row onto the UPSERT_CARRIER input. Status is always PENDING:
 * vetting is a decision a person makes in the app, not something an import does.
 * @param {Record<string, string>} row
 * @param {number} index
 * @returns {{valid: boolean, carrier?: any, contacts?: any[], notes?: string[], errors: string[]}}
 */
export function mapCarrierRow(row, index) {
  if (!row || typeof row !== 'object') {
    return { valid: false, errors: [`row ${index} is not an object`] };
  }

  const name = pickField(row, 'name');
  if (!name) return { valid: false, errors: ['name is missing/empty'] };
  if (/^(unknown|unk|n\/a|tbd)$/i.test(name)) {
    return { valid: false, errors: [`name "${name}" is a placeholder`] };
  }

  const notes = [];
  const rawType = pickField(row, 'type');
  const type = normalizeCarrierType(rawType);
  if (type === undefined) {
    return { valid: false, errors: [`unknown carrier type "${rawType}"`] };
  }

  const mcNumber = normalizeDocket(pickField(row, 'mcNumber'));
  const dotNumber = normalizeDocket(pickField(row, 'dotNumber'));
  if (!mcNumber && !dotNumber) notes.push('no MC or DOT number in the export');
  if (type === null) notes.push(`carrier type defaulted to TL (export value: "${rawType || 'blank'}")`);

  const carrier = {
    name,
    type: type ?? 'TL',
    status: 'PENDING',
  };

  const scalars = [
    ['dbaName', 'dbaName'], ['scac', 'scac'], ['einNumber', 'einNumber'],
    ['phone', 'phone'], ['email', 'email'], ['website', 'website'],
    ['dispatcherName', 'dispatcherName'], ['dispatcherPhone', 'dispatcherPhone'],
    ['dispatcherEmail', 'dispatcherEmail'], ['internalNotes', 'internalNotes'],
  ];
  for (const [field, source] of scalars) {
    const value = pickField(row, source);
    if (value) carrier[field] = value;
  }
  if (mcNumber) carrier.mcNumber = mcNumber;
  if (dotNumber) carrier.dotNumber = dotNumber;

  const address = {};
  for (const part of ['street', 'city', 'state', 'zip', 'country']) {
    const value = pickField(row, part);
    if (value) address[part] = value;
  }
  if (Object.keys(address).length > 0) carrier.address = address;

  const authority = AUTHORITY_STATUSES.get(pickField(row, 'authorityStatus').toLowerCase());
  if (authority) carrier.authorityStatus = authority;
  const authorityGrantedAt = parseExportDate(pickField(row, 'authorityGrantedAt'));
  if (authorityGrantedAt) carrier.authorityGrantedAt = authorityGrantedAt;

  const safety = SAFETY_RATINGS.get(pickField(row, 'safetyRating').toLowerCase());
  if (safety) carrier.safetyRating = safety;
  const safetyRatingAt = parseExportDate(pickField(row, 'safetyRatingAt'));
  if (safetyRatingAt) carrier.safetyRatingAt = safetyRatingAt;

  for (const [field, source] of [['highwayStatus', 'highwayStatus'], ['rmisStatus', 'rmisStatus']]) {
    const mapped = COMPLIANCE_STATUSES.get(pickField(row, source).toLowerCase());
    if (mapped) carrier[field] = mapped;
  }
  const mcpStatus = pickField(row, 'mcpStatus');
  if (mcpStatus) carrier.mcpStatus = mcpStatus;

  const equipment = normalizeEquipment(pickField(row, 'equipment'));
  if (equipment.length > 0) carrier.equipment = equipment;

  for (const [field, source] of [['powerUnits', 'powerUnits'], ['trailerCount', 'trailerCount'], ['driverCount', 'driverCount'], ['paymentTermsDays', 'paymentTermsDays']]) {
    const value = parseCount(pickField(row, source));
    if (value !== null) carrier[field] = value;
  }

  const { policies, issues } = buildInsurancePolicies(row);
  if (policies.length > 0) carrier.insurancePolicies = policies;
  notes.push(...issues);

  return { valid: true, carrier, contacts: buildContacts(row), notes, errors: [] };
}

/**
 * Map every row and drop the ones that cannot be imported without guessing.
 * Duplicates inside the export itself (same normalized name, MC or DOT) are
 * collapsed to the first occurrence — the Lambda refuses them anyway.
 * @param {Array<Record<string, string>>} rows
 * @returns {{selected: any[], skipped: any[], reviewables: any[]}}
 */
export function selectCarrierRows(rows) {
  const selected = [];
  const skipped = [];
  const reviewables = [];
  const byName = new Map();
  const byMc = new Map();
  const byDot = new Map();

  for (let i = 0; i < rows.length; i++) {
    const { valid, carrier, contacts, notes, errors } = mapCarrierRow(rows[i], i);
    if (!valid) {
      skipped.push({ index: i, row: rows[i], reason: errors.join('; ') });
      continue;
    }

    const key = normalizeCustomerName(carrier.name);
    const duplicate =
      (key && byName.get(key)) ||
      (carrier.mcNumber && byMc.get(carrier.mcNumber)) ||
      (carrier.dotNumber && byDot.get(carrier.dotNumber));
    if (duplicate) {
      skipped.push({ index: i, row: rows[i], reason: `duplicate of "${duplicate}" earlier in the export` });
      continue;
    }

    byName.set(key, carrier.name);
    if (carrier.mcNumber) byMc.set(carrier.mcNumber, carrier.name);
    if (carrier.dotNumber) byDot.set(carrier.dotNumber, carrier.name);

    selected.push({ index: i, key, carrier, contacts });
    for (const note of notes) {
      reviewables.push({ kind: 'CARRIER_IMPORT_NOTE', reason: note, source: { index: i, name: carrier.name } });
    }
  }

  return { selected, skipped, reviewables };
}

/**
 * Count the shape of the import so a reviewer can sanity-check it without
 * reading every row.
 * @param {any[]} selected
 * @returns {Record<string, unknown>}
 */
export function tallySelected(selected) {
  const byType = {};
  const byAuthority = {};
  let withCargoPolicy = 0;
  let withAutoPolicy = 0;
  let contacts = 0;

  for (const entry of selected) {
    const { carrier } = entry;
    byType[carrier.type] = (byType[carrier.type] ?? 0) + 1;
    const authority = carrier.authorityStatus ?? 'UNSPECIFIED';
    byAuthority[authority] = (byAuthority[authority] ?? 0) + 1;
    const policies = carrier.insurancePolicies ?? [];
    if (policies.some((p) => p.type === 'CARGO')) withCargoPolicy++;
    if (policies.some((p) => p.type === 'AUTO_LIABILITY')) withAutoPolicy++;
    contacts += entry.contacts.length;
  }

  return { byType, byAuthority, withCargoPolicy, withAutoPolicy, contacts };
}

/**
 * The source fingerprint: every carrier the plan intends to create and the
 * identifiers it was matched on. An edited export invalidates the plan.
 * @param {any[]} selected
 * @returns {Array<Record<string, unknown>>}
 */
function sourceRowsOf(selected) {
  return selected.map((entry) => ({
    key: entry.key,
    name: String(entry.carrier.name),
    mcNumber: String(entry.carrier.mcNumber ?? ''),
    dotNumber: String(entry.carrier.dotNumber ?? ''),
  }));
}

/**
 * tmsClient has no carrier helper, so the mutation is called directly through
 * its `gql` escape hatch. Same AWSJSON unwrapping the other action helpers do.
 * @param {any} client
 * @param {string} action
 * @param {unknown} input
 */
async function carrierAction(client, action, input) {
  const data = await client.gql(
    `mutation C($action: String!, $input: AWSJSON!) {
      tmsCarrierActions(action: $action, input: $input)
    }`,
    { action, input: JSON.stringify(input) }
  );
  const raw = data?.tmsCarrierActions;
  return typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
}

const CARRIER_LIST_FIELDS = 'id name normalizedName mcNumber dotNumber status updatedAt';

/**
 * Read the whole carrier directory so apply can skip what is already there.
 * A read failure surfaces as a failure, not as "every carrier is new".
 * @param {any} client
 * @returns {Promise<any[]>}
 */
async function fetchExistingCarriers(client) {
  const items = [];
  let nextToken = null;
  do {
    const data = await client.gql(
      `query LC($limit: Int, $nextToken: String) {
        listCarriers(limit: $limit, nextToken: $nextToken) {
          items { ${CARRIER_LIST_FIELDS} }
          nextToken
        }
      }`,
      { limit: 1000, nextToken }
    );
    items.push(...(data?.listCarriers?.items ?? []));
    nextToken = data?.listCarriers?.nextToken ?? null;
  } while (nextToken);
  return items;
}

/**
 * Find an already-imported carrier by normalized name, MC or DOT.
 * @param {any[]} existing
 * @param {any} carrier
 * @param {string} key
 * @returns {any | null}
 */
export function findExistingCarrier(existing, carrier, key) {
  return (
    existing.find((c) => key && normalizeCustomerName(c.name) === key) ??
    existing.find((c) => carrier.mcNumber && normalizeDocket(c.mcNumber) === carrier.mcNumber) ??
    existing.find((c) => carrier.dotNumber && normalizeDocket(c.dotNumber) === carrier.dotNumber) ??
    null
  );
}

/**
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export function buildCarrierImportPlan({ inputPath, env, endpoint }) {
  const { rows, format } = readCarrierExport(inputPath);
  const { selected, skipped, reviewables } = selectCarrierRows(rows);

  const actions = [];
  for (const entry of selected) {
    actions.push({
      action: 'UPSERT_CARRIER',
      purpose: 'Create the carrier (PENDING) with the insurance policies the export documents',
      carrierKey: entry.key,
      input: entry.carrier,
    });
    for (const contact of entry.contacts) {
      actions.push({
        action: 'UPSERT_CONTACT',
        purpose: 'Create a carrier contact; carrierId is filled in from the carrier created above',
        carrierKey: entry.key,
        input: contact,
      });
    }
  }

  if (selected.length === 0) {
    reviewables.push({
      kind: 'EMPTY_IMPORT',
      reason: 'No importable carriers found; the export may be empty or its headers may not be recognised',
      source: { input: inputPath, format, rows: rows.length, skipped },
    });
  }

  return createPlan({
    environment: env,
    endpoint,
    sourceType: `aljex-highway-carrier-export (${format})`,
    sourceRows: sourceRowsOf(selected),
    actions,
    reviewables,
    unresolved: skipped,
    summary: {
      exportRows: rows.length,
      carriers: selected.length,
      skipped: skipped.length,
      actions: actions.length,
      ...tallySelected(selected),
    },
  });
}

/**
 * Execute a reviewed carrier import plan.
 * @param {object} opts
 * @param {any} opts.client
 * @param {string} opts.planPath
 * @param {string} opts.inputPath
 * @param {string} opts.env
 * @param {string} opts.endpoint
 */
export async function applyCarrierImportPlan({ client, planPath, inputPath, env, endpoint }) {
  const plan = loadPlan(planPath);
  const { rows } = readCarrierExport(inputPath);
  const { selected } = selectCarrierRows(rows);
  validatePlan(plan, { environment: env, endpoint, sourceRows: sourceRowsOf(selected) });

  const existing = await fetchExistingCarriers(client);
  const carrierIds = new Map();
  const alreadyPresent = new Set();

  let carriers = 0;
  let contacts = 0;
  const skipped = [];
  const conflicts = [];

  for (const entry of plan.actions) {
    const key = entry.carrierKey;
    try {
      if (entry.action === 'UPSERT_CARRIER') {
        const match = findExistingCarrier(existing, entry.input, key);
        if (match) {
          alreadyPresent.add(key);
          carrierIds.set(key, match.id);
          skipped.push({ carrierKey: key, name: entry.input.name, reason: `CARRIER_EXISTS (${match.id})` });
          continue;
        }
        const created = await carrierAction(client, 'UPSERT_CARRIER', entry.input);
        carrierIds.set(key, created?.id);
        carriers++;
        continue;
      }

      if (entry.action === 'UPSERT_CONTACT') {
        // Contacts belong to a carrier this run created. An existing carrier keeps
        // the contacts it already has rather than collecting a duplicate per re-run.
        if (alreadyPresent.has(key)) {
          skipped.push({ carrierKey: key, name: entry.input.name, reason: 'CARRIER_EXISTS (contact not imported)' });
          continue;
        }
        const carrierId = carrierIds.get(key);
        if (!carrierId) {
          skipped.push({ carrierKey: key, name: entry.input.name, reason: 'CARRIER_NOT_CREATED' });
          continue;
        }
        await carrierAction(client, 'UPSERT_CONTACT', { ...entry.input, carrierId });
        contacts++;
      }
    } catch (err) {
      conflicts.push({ action: entry.action, carrierKey: key, name: entry.input?.name, error: err.message });
    }
  }

  return { environment: env, planPath, inputPath, carriers, contacts, skipped, conflicts };
}

/**
 * @param {string | undefined} env
 * @returns {boolean}
 */
export function isProductionEnv(env) {
  return PRODUCTION_ENVS.includes(String(env ?? '').trim().toLowerCase());
}

/**
 * Mode resolution that knows about the cutover. Everything except a production
 * apply goes through the shared `detectMode`, so test/sandbox/local keep exactly
 * the guards the other migrations have; a production apply is handled here and
 * then has to clear `assertCutoverConfirm` before a single call is made.
 * @param {boolean | undefined} apply
 * @param {string | undefined} env
 * @returns {{mode: 'dry-run' | 'apply', env: string, production: boolean}}
 */
export function resolveCarrierMode(apply, env) {
  if (apply && isProductionEnv(env)) {
    return { mode: 'apply', env: String(env).trim().toLowerCase(), production: true };
  }
  const resolved = detectMode(Boolean(apply), env);
  return { ...resolved, production: isProductionEnv(resolved.env) };
}

/**
 * Outputs loader. Non-production keeps `loadAmplifyOutputs`, which refuses the
 * repo-root production file. Production reads the file the operator named, and
 * naming it is one of the four cutover conditions, so there is no default and no
 * way to hit production by forgetting a flag.
 * @param {string | undefined} outputsPath
 * @param {boolean} production
 * @returns {Record<string, unknown>}
 */
export function loadCarrierOutputs(outputsPath, production) {
  if (!outputsPath) {
    throw new Error(
      production
        ? '--outputs <path to the production amplify_outputs.json> must be named explicitly for a production run'
        : '--outputs <path> is required'
    );
  }
  if (!production) {
    return loadAmplifyOutputs(outputsPath);
  }
  const resolved = resolve(process.cwd(), outputsPath);
  if (!existsSync(resolved)) {
    throw new Error(`--outputs file not found: ${resolved}`);
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

/**
 * The cutover handshake: the operator has to have opened the reviewed plan and
 * copied its fingerprint into the environment. A missing variable and a stale
 * one (a plan regenerated after the confirm was exported) are different
 * mistakes, so they get different messages.
 * @param {object} opts
 * @param {string} opts.env
 * @param {string} opts.planPath
 * @param {string} opts.planFingerprint
 * @param {string | undefined} opts.confirm
 * @returns {string}
 */
export function assertCutoverConfirm({ env, planPath, planFingerprint, confirm }) {
  const provided = String(confirm ?? '').trim();
  if (!provided) {
    throw new Error(
      `Refusing to apply to "${env}": ${CUTOVER_CONFIRM_VAR} is not set. ` +
        `Read the "fingerprint" field of the reviewed plan ${planPath} and re-run with ` +
        `${CUTOVER_CONFIRM_VAR}=<that fingerprint>.`
    );
  }
  if (provided !== planFingerprint) {
    throw new Error(
      `Refusing to apply to "${env}": ${CUTOVER_CONFIRM_VAR} does not match the plan fingerprint. ` +
        `${CUTOVER_CONFIRM_VAR}=${provided}, plan ${planPath} fingerprint=${planFingerprint}. ` +
        `Review the plan again and confirm the fingerprint it actually carries.`
    );
  }
  return planFingerprint;
}

async function main() {
  const args = parseTmsArgs();
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!args.values.input) {
    throw new Error('--input <path> is required');
  }

  const { mode, env, production } = resolveCarrierMode(args.values.apply, args.values.env);
  const inputPath = resolve(process.cwd(), args.values.input);
  const outputs = loadCarrierOutputs(args.values.outputs, production);
  const endpoint = outputs?.data?.url;
  if (!endpoint) {
    throw new Error('amplify_outputs.json missing data.url');
  }

  if (mode === 'dry-run') {
    const plan = buildCarrierImportPlan({ inputPath, env, endpoint });
    const planPath = args.values.plan;
    if (planPath) {
      savePlan(plan, resolve(process.cwd(), planPath));
      console.log(`Plan written to ${planPath}`);
      console.log(summarize(plan));
      console.log(JSON.stringify(plan.summary, null, 2));
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
    process.exit(0);
  }

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying');
  }

  if (production) {
    const reviewed = loadPlan(resolve(process.cwd(), args.values.plan));
    assertCutoverConfirm({
      env,
      planPath: args.values.plan,
      planFingerprint: reviewed.fingerprint,
      confirm: process.env[CUTOVER_CONFIRM_VAR],
    });
    console.error(`PRODUCTION CUTOVER: applying ${args.values.plan} (${reviewed.fingerprint}) to ${env}`);
  }
  const auth = await authenticateTmsUser(outputs);
  const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
  const report = await applyCarrierImportPlan({
    client,
    planPath: resolve(process.cwd(), args.values.plan),
    inputPath,
    env,
    endpoint,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts.length > 0) {
    process.exit(2);
  }
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
