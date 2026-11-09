/**
 * Pure parts of scripts/awCarriers.mjs (no AWS, no files): which shipments awPreDelete will delete, which carriers are
 * USED since the cutoff, which carriers may be deleted, and the enrich-only billing patch.
 *
 * Nothing here ever sees a bank account, routing number or tax id: the carriers CSV is parsed by the app's own
 * parseCarrierRows (src/lib/aljex/layouts/carriers.ts), which counts the sensitive columns and never copies them.
 *
 * "Retained" mirrors scripts/lib/preDelete.mjs (selectShipments / planPreDelete / splitPayment): a shipment is deleted
 * only when it is a pure-numeric legacyImported Shipment whose export Ship Date is a single date before the cutoff;
 * its Loads, LoadCarriers, CarrierBills (and an ApPayment that only pays those bills) go with it.
 */
import { createHash } from 'node:crypto';
import { normalizePro } from '../../src/lib/proNumber.ts';

export const CUTOFF = '2025-01-01';
export const AUDIT_USER = 'system:awCarriers';

const str = (v) => (v == null ? '' : String(v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
export const isPureNumeric = (v) => /^\d+$/.test(str(v).trim());

/** Numeric PRO key: `L14727`, `14727  ` and `PRO# 14727` all -> `14727`; anything else -> null. */
export function proKey(value) {
  const n = normalizePro(typeof value === 'number' ? String(value) : value);
  if (!n) return null;
  const m = /^L?(\d+)$/.exec(n);
  return m ? m[1] : null;
}

/** MM/DD/YY(YY) -> YYYY-MM-DD. Two-digit years use the POSIX pivot exactly like awPreDelete (70 -> 1970, so it is "before the cutoff"). */
export function parseShipDate(value) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/.exec(value ?? '');
  if (!m) return null;
  const yy = Number(m[3]);
  const year = m[3].length === 2 ? (yy <= 68 ? 2000 + yy : 1900 + yy) : yy;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Export rows `{pro, shipDate}` -> PRO key -> `{date, max, ambiguous}`. `date` is the single real date (null when none or
 * when rows disagree); `max` is the latest real date (used only to decide "used since the cutoff" conservatively).
 */
export function indexShipDates(rows) {
  const dates = new Map();
  for (const r of rows) {
    const key = proKey(r.pro);
    if (!key) continue;
    const set = dates.get(key) ?? dates.set(key, new Set()).get(key);
    const d = parseShipDate(r.shipDate);
    if (d) set.add(d);
  }
  const out = new Map();
  for (const [k, set] of dates) {
    const real = [...set].sort();
    out.set(k, { date: real.length === 1 ? real[0] : null, max: real.length ? real[real.length - 1] : null, ambiguous: real.length > 1 });
  }
  return out;
}

/**
 * One entry per shipment id: `{deleted, date, source}`.
 *  deleted  - awPreDelete will delete it (same rule as preDelete.selectShipments: pure-numeric legacyImported, single export date < cutoff).
 *  date     - the ship date used for "used since the cutoff": the export's (latest if rows disagree), else the shipment's pickupAppt day, else null.
 */
export function classifyShipments({ shipments, shipDates, cutoff = CUTOFF }) {
  const out = new Map();
  for (const s of shipments) {
    const key = proKey(s.number);
    const hit = key ? shipDates.get(key) : undefined;
    const candidate = isPureNumeric(s.number) && s.legacyImported === true;
    const deleted = candidate && !!hit && !hit.ambiguous && !!hit.date && hit.date < cutoff;
    let date = hit?.max ?? null;
    let source = date ? 'export' : null;
    if (!date) {
      const pick = /^\d{4}-\d{2}-\d{2}/.exec(str(s.pickupAppt));
      if (pick) { date = pick[0]; source = 'pickup'; }
    }
    out.set(s.id, { deleted, date, source, number: s.number });
  }
  return out;
}

const parseApps = (v) => {
  if (v == null) return [];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return Array.isArray(v) ? v : [];
};

/**
 * Which LoadCarrier / CarrierBill / ApPayment rows awPreDelete removes. Same derivation as planPreDelete; an ApPayment that
 * still carries a retained application, unapplied money or a credit is retained (edited, not deleted).
 * @returns {{deletedLoads: Set<string>, deletedLoadCarriers: Set<string>, deletedBills: Set<string>, deletedApPayments: Set<string>}}
 */
export function deletedByPreDelete({ shipmentInfo, loads, loadCarriers, bills, apPayments }) {
  const S = new Set([...shipmentInfo].filter(([, v]) => v.deleted).map(([id]) => id));
  const deletedLoads = new Set(loads.filter((l) => S.has(l.shipmentId)).map((l) => l.id));
  const lcRows = loadCarriers.filter((r) => S.has(r.shipmentId) || deletedLoads.has(r.loadId));
  const deletedLoadCarriers = new Set(lcRows.map((r) => r.id));
  const deletedBills = new Set(bills.filter((r) => S.has(r.shipmentId) || deletedLoads.has(r.loadId) || deletedLoadCarriers.has(r.loadCarrierId)).map((r) => r.id));
  const deletedApPayments = new Set();
  for (const p of apPayments) {
    const apps = parseApps(p.applications);
    const old = apps.filter((a) => deletedBills.has(str(a.billId)));
    if (old.length === 0) continue;
    const kept = apps.length - old.length;
    if (kept === 0 && num(p.unappliedCents) === 0 && parseApps(p.creditApplications).length === 0) deletedApPayments.add(p.id);
  }
  return { deletedLoads, deletedLoadCarriers, deletedBills, deletedApPayments };
}

/** Table names the carrier-reference scan covers (each has a `carrierId`). Children are checked separately. */
export const REF_TABLES = ['LoadCarrier', 'CarrierBill', 'ApPayment', 'Quote', 'LaneRateSample', 'Commission'];
export const CHILD_TABLES = ['CarrierContact', 'CarrierPaymentMethod', 'CarrierDocument'];

/** Carrier ids named inside a Customer.quotingDefaults / TmsSettings.customerPortalDefaults JSON (blocked / self-quote lists). */
export function carrierIdsInJson(value) {
  let obj = value;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return []; } }
  if (!obj || typeof obj !== 'object') return [];
  const out = [];
  for (const k of ['blockedLtlCarrierIds', 'selfQuoteCarrierIds']) if (Array.isArray(obj[k])) out.push(...obj[k].map(str).filter(Boolean));
  return out;
}

/**
 * Resolve a stored carrier reference to a Carrier row id: an exact id, else an Aljex code / merged alias of one carrier
 * (never a name). Returns null when it names no carrier row (dangling).
 */
export function carrierResolver(carriers) {
  const byId = new Map(carriers.map((c) => [c.id, c.id]));
  const byCode = new Map();
  for (const c of carriers) {
    if (!blank(c.aljexCode)) byCode.set(str(c.aljexCode), c.id);
    for (const a of c.aljexAliases ?? []) byCode.set(str(a), c.id);
  }
  return (ref) => (ref == null || ref === '' ? null : byId.get(str(ref)) ?? byCode.get(str(ref)) ?? null);
}

/**
 * Per-carrier references. `live` counts every row that exists today; `retained` excludes the rows awPreDelete deletes.
 * `used` counts retained LoadCarrier/CarrierBill rows whose shipment ship date is >= cutoff; `undated` counts retained ones with no date.
 *
 * @returns {{byCarrier: Map<string, {live: Record<string, number>, retained: Record<string, number>, used: number, undated: number, olderOnly: number}>, dangling: Record<string, number>}}
 */
export function referenceMap({ carriers, rows, shipmentInfo, loads, deleted, jsonRefs = [], cutoff = CUTOFF }) {
  const resolve = carrierResolver(carriers);
  const loadShip = new Map(loads.map((l) => [l.id, l.shipmentId]));
  const byCarrier = new Map();
  const dangling = {};
  const entry = (id) => byCarrier.get(id) ?? byCarrier.set(id, { live: {}, retained: {}, used: 0, undated: 0, olderOnly: 0 }).get(id);
  const bump = (o, t) => { o[t] = (o[t] ?? 0) + 1; };
  const goneOf = { LoadCarrier: deleted.deletedLoadCarriers, CarrierBill: deleted.deletedBills, ApPayment: deleted.deletedApPayments };
  for (const table of REF_TABLES) {
    for (const r of rows[table] ?? []) {
      const cid = resolve(r.carrierId);
      if (!cid) { if (!blank(r.carrierId)) dangling[table] = (dangling[table] ?? 0) + 1; continue; }
      const e = entry(cid);
      bump(e.live, table);
      if (goneOf[table]?.has(r.id)) continue;
      bump(e.retained, table);
      if (table === 'LoadCarrier' || table === 'CarrierBill') {
        const sid = r.shipmentId ?? loadShip.get(r.loadId);
        const info = sid ? shipmentInfo.get(sid) : undefined;
        if (!info?.date) e.undated += 1;
        else if (info.date >= cutoff) e.used += 1;
        else e.olderOnly += 1;
      }
    }
  }
  for (const { table, carrierId } of jsonRefs) {
    const cid = resolve(carrierId);
    if (!cid) continue;
    const e = entry(cid);
    bump(e.live, table);
    bump(e.retained, table);
  }
  return { byCarrier, dangling };
}

const lastLoadDay = (c) => (/^\d{4}-\d{2}-\d{2}/.exec(str(c.lastLoadAt)) ?? [null])[0];

/**
 * The three decisions, from carriers + references + children.
 *  activate: used (retained LoadCarrier/Bill with ship >= cutoff, or undated when `undatedUsed`) and status PENDING/REVIEW/INACTIVE.
 *            DO_NOT_USE is never activated (listed as a conflict); ACTIVE is already done.
 *  delete:   not used, no retained reference, no child rows, not DO_NOT_USE, not alias-linked to a kept carrier.
 *            Carriers whose own lastLoadAt is >= cutoff but that no retained row names are KEPT for review (protectLastLoad).
 *            `blockedNow` = still referenced today by rows awPreDelete deletes: apply refuses until that delete ran.
 *  keep:     everything else, with the reasons (referencing table, children, DO_NOT_USE, alias link).
 */
export function planCarriers({ carriers, refs, children = {}, undatedUsed = true, keepDoNotUse = true, protectLastLoad = true }) {
  const out = { activate: [], alreadyActive: [], doNotUseUsed: [], delete: [], keep: [], keepNotUsed: [], usedIds: new Set(), lastLoadAt: { both: [], onlyUsed: [], onlyLastLoadAt: [] } };
  const byId = new Map(carriers.map((c) => [c.id, c]));
  const childCount = (id) => CHILD_TABLES.reduce((acc, t) => { const n = children[t]?.get(id) ?? 0; if (n) acc[t] = n; return acc; }, {});
  const used = new Set();
  for (const c of carriers) {
    const r = refs.get(c.id);
    if (r && (r.used > 0 || (undatedUsed && r.undated > 0))) used.add(c.id);
  }
  out.usedIds = used;

  // lastLoadAt vs our own computation (reported, never trusted)
  for (const c of carriers) {
    const l = lastLoadDay(c);
    const stale = l != null && l >= CUTOFF;
    if (used.has(c.id) && stale) out.lastLoadAt.both.push(c.id);
    else if (used.has(c.id)) out.lastLoadAt.onlyUsed.push(c.id);
    else if (stale) out.lastLoadAt.onlyLastLoadAt.push(c.id);
  }

  for (const c of carriers) {
    if (!used.has(c.id)) continue;
    if (c.status === 'ACTIVE') out.alreadyActive.push(c.id);
    else if (c.status === 'DO_NOT_USE') out.doNotUseUsed.push(c.id);
    else out.activate.push({ id: c.id, previousStatus: c.status ?? null, previousReason: c.statusReason ?? null });
  }

  // Alias links: an identifier (Aljex code or merged alias) shared with another carrier row keeps both.
  const idOwners = new Map();
  for (const c of carriers) for (const k of [c.aljexCode, ...(c.aljexAliases ?? [])].filter((x) => !blank(x)).map(str)) (idOwners.get(k) ?? idOwners.set(k, new Set()).get(k)).add(c.id);
  const aliasLinked = (c) => {
    for (const k of [c.aljexCode, ...(c.aljexAliases ?? [])].filter((x) => !blank(x)).map(str)) {
      for (const other of idOwners.get(k) ?? []) if (other !== c.id && (used.has(other) || !byId.has(other))) return true;
    }
    return false;
  };

  for (const c of carriers) {
    if (used.has(c.id)) continue;
    const r = refs.get(c.id);
    const reasons = [];
    for (const [t, n] of Object.entries(r?.retained ?? {})) if (n > 0) reasons.push({ table: t, count: n });
    for (const [t, n] of Object.entries(childCount(c.id))) reasons.push({ table: t, count: n });
    if (keepDoNotUse && c.status === 'DO_NOT_USE') reasons.push({ table: 'Carrier.status', count: 1, why: 'DO_NOT_USE blocklist entry' });
    if (protectLastLoad && (lastLoadDay(c) ?? '') >= CUTOFF) reasons.push({ table: 'Carrier.lastLoadAt', count: 1, why: `lastLoadAt >= ${CUTOFF} but no retained load row names it (review)` });
    if (aliasLinked(c)) reasons.push({ table: 'Carrier.aljexAliases', count: 1, why: 'alias shared with a kept carrier' });
    const live = Object.values(r?.live ?? {}).reduce((a, b) => a + b, 0);
    if (reasons.length) out.keep.push({ id: c.id, status: c.status ?? null, reasons });
    else out.delete.push({ id: c.id, status: c.status ?? null, blockedNow: live > 0, liveRefs: r?.live ?? {} });
  }
  return out;
}

/** Delete-time check: refuse a carrier that anything still points at. `live` = live reference tallies per table + child tables. */
export function refusalFor(liveRefs) {
  const bad = Object.entries(liveRefs).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`);
  return bad.length ? `still referenced (${bad.join(', ')})` : null;
}

// ── export (restore copy of the deleted Carrier rows) ──────────────────────────────────────────────────

/** Any attribute whose name looks like a tax id / bank / routing / secret is dropped from the export. */
const SENSITIVE_KEY = /taxid|bank|routing|\bssn|\bein\b|fedss|secret|password|fingerprint|cipher/i;
export const isSensitiveKey = (k) => SENSITIVE_KEY.test(k);

/** Free text keeps its words but loses anything shaped like a tax id, and the id after "factor" (an Aljex factor id is a 9-digit key). */
export function scrubText(text) {
  return text
    .replace(/(factor\s+(?:id\s*)?#?)\d[\d-]*/gi, '$1[redacted]')
    .replace(/\b\d{2}-\d{7}\b/g, '[redacted]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]');
}

/** The Carrier row without its tax-id mirror (taxIdLast4/Type/OnFileAt), any bank/tax-looking attribute, and tax-shaped text in notes. */
export function exportableCarrier(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (isSensitiveKey(k)) continue;
    out[k] = typeof v === 'string' && /notes?$/i.test(k) ? scrubText(v) : v;
  }
  return out;
}

// ── billing (enrich only) ───────────────────────────────────────────────────────────────────────────────

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => !blank(v)));
const hasAddress = (a) => {
  let v = a;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return !blank(a); } }
  return !!v && typeof v === 'object' && (!blank(v.street) || !blank(v.city));
};

/** Carrier fields the billing step may fill (and nothing else). */
export const BILLING_CARRIER_FIELDS = ['address', 'phone', 'dispatcherName', 'paymentTermsDays', 'quickPayEligible', 'defaultQuickPayDays'];

/** CarrierPaymentMethod id the script writes: one deterministic row per carrier, so a re-run can never double it. */
export const paymentMethodId = (carrierId) => `pm-aljex-${carrierId}`;

/**
 * One carrier: what to fill from its Aljex master row, only where the target is empty.
 * @param {object} carrier production Carrier row
 * @param {object} master  CarrierMasterRow (parseCarrierRows output)
 * @param {number} methodCount existing CarrierPaymentMethod rows of this carrier
 * @returns {{patch: Record<string, unknown>, method: object|null, differs: string[]}}
 */
export function planBilling(carrier, master, methodCount = 0, now = new Date()) {
  const patch = {};
  const differs = [];
  const m = master;
  if (!hasAddress(carrier.address) && (m.street || m.city)) patch.address = compact({ street: m.street, city: m.city, state: m.state, zip: m.zip, country: 'US' });
  else if (m.street && hasAddress(carrier.address)) { /* present: never overwritten */ }
  if (blank(carrier.phone)) { if (m.phone) patch.phone = m.phone; } else if (m.phone && str(carrier.phone).replace(/\D/g, '') !== m.phone.replace(/\D/g, '')) differs.push('phone');
  if (blank(carrier.dispatcherName) && m.contact) patch.dispatcherName = m.contact;
  if (typeof carrier.paymentTermsDays !== 'number' && m.termsDays != null) patch.paymentTermsDays = m.termsDays;
  else if (typeof carrier.paymentTermsDays === 'number' && m.termsDays != null && carrier.paymentTermsDays !== m.termsDays) differs.push('paymentTermsDays');
  if (carrier.quickPayEligible == null && m.quickPay.eligible) patch.quickPayEligible = true;
  if (m.quickPay.eligible && m.quickPay.days != null && typeof carrier.defaultQuickPayDays !== 'number') patch.defaultQuickPayDays = m.quickPay.days;

  let method = null;
  const remit = compact({ street: m.remit.street, city: m.remit.city, state: m.remit.state, zip: m.remit.zip, country: 'US' });
  const hasRemit = !blank(m.remit.street) || !blank(m.remit.city);
  const payee = !blank(m.payableTo) ? m.payableTo : '';
  if (methodCount === 0 && (hasRemit || (payee && payee !== m.name))) {
    const at = now.toISOString();
    method = {
      id: paymentMethodId(carrier.id), __typename: 'CarrierPaymentMethod', carrierId: carrier.id, method: 'CHECK', recipientType: 'CARRIER',
      ...(payee ? { accountName: payee } : {}), ...(hasRemit ? { remitToAddress: remit } : {}),
      isPreferred: true, status: 'ACTIVE', source: 'ALJEX', createdBy: AUDIT_USER, updatedBy: AUDIT_USER, createdAt: at, updatedAt: at,
    };
  }
  return { patch, method, differs };
}

/**
 * CSV master rows -> production carriers, the way runCarriersMaster resolves them: MC/DOT first (a split is skipped), then the
 * Aljex Carrier ID / merged aliases. A name is never a key.
 * @returns {{matched: Map<string, {master: object, how: string}>, unmatched: string[], conflicts: string[], duplicates: string[]}}
 */
export function matchMasters(carriers, masters, digitsOf = (s) => str(s).replace(/\D/g, '').replace(/^0+/, '')) {
  const byMc = new Map();
  const byDot = new Map();
  const byCode = new Map();
  for (const c of carriers) {
    if (digitsOf(c.mcNumber)) byMc.set(digitsOf(c.mcNumber), c);
    if (digitsOf(c.dotNumber)) byDot.set(digitsOf(c.dotNumber), c);
    if (!blank(c.aljexCode)) byCode.set(str(c.aljexCode), c);
    for (const a of c.aljexAliases ?? []) byCode.set(str(a), c);
  }
  const matched = new Map();
  const out = { matched, unmatched: [], conflicts: [], duplicates: [] };
  for (const m of masters) {
    const hitMc = digitsOf(m.mc) ? byMc.get(digitsOf(m.mc)) : undefined;
    const hitDot = digitsOf(m.dot) ? byDot.get(digitsOf(m.dot)) : undefined;
    if (hitMc && hitDot && hitMc.id !== hitDot.id) { out.conflicts.push(m.id); continue; }
    let link = hitMc ?? hitDot;
    let how = 'MC_DOT';
    if (!link) { link = [m.id, ...m.aliases].map((k) => byCode.get(k)).find(Boolean); how = 'ID'; }
    if (!link) { out.unmatched.push(m.id); continue; }
    if (matched.has(link.id)) { out.duplicates.push(m.id); continue; }
    matched.set(link.id, { master: m, how });
  }
  return out;
}

// ── export manifest ─────────────────────────────────────────────────────────────────────────────────────

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The restore copy of the carriers about to be deleted: carriers.jsonl (scrubbed Carrier rows), vault-carrier-ids.json
 * (WHICH carriers had a vault row; never a value) and a manifest with counts + sha256.
 */
export function buildExport({ carriers, vaultCarrierIds, suffix, now = new Date() }) {
  const lines = carriers.map((c) => JSON.stringify(exportableCarrier(c))).join('\n');
  const files = {
    'carriers.jsonl': lines ? `${lines}\n` : '',
    'vault-carrier-ids.json': `${JSON.stringify([...vaultCarrierIds].sort(), null, 1)}\n`,
  };
  const manifest = {
    createdAt: now.toISOString(),
    suffix,
    counts: { carriers: carriers.length, inactive: carriers.filter((c) => c.status === 'INACTIVE').length, vaultRows: vaultCarrierIds.length },
    files: Object.entries(files).map(([name, text]) => ({ name, sha256: sha256(text), bytes: Buffer.byteLength(text) })),
    note: 'Carrier rows without tax-id mirror / bank / routing attributes. Vault ciphertext is NOT exported: restore it from the on-demand CarrierTaxVault backup.',
  };
  return { files, manifest };
}

/** True when every file of the manifest reads back with its recorded sha256. */
export function verifyExport(manifest, readText) {
  return manifest.files.every((f) => sha256(readText(f.name)) === f.sha256);
}
