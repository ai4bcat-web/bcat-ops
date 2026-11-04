#!/usr/bin/env node
// Streaming aggregate profiler for Ryne's Aljex full export (486 columns, one row per load).
//
//   node scripts/aljexProfile.mjs [csvPath] [--out /path/outside/repo/profile.json]
//
// PII contract: the CSV lives OUTSIDE the repo and is only streamed from its absolute
// path. Output is JSON of AGGREGATES only: fill/distinct counts, min/max/sums, date
// shape and year buckets, and value-frequency tables for columns that are categorical
// codes (<= 40 distinct values, each <= 24 chars) - never for name/address/phone/
// email/reference/MC/DOT/driver/customer/carrier columns. No row value is ever kept
// beyond the aggregate it contributes to. --out is refused inside the repo.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GROUP_COUNTS, groupColumns, scalarColumns } from './lib/aljexColumns.mjs';
import { createCsvParser } from './lib/csvStream.mjs';

export const DEFAULT_CSV = '/Users/adminoid/aljex-export/aljex-full-export-2026-11-03.csv';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_MAX_DISTINCT = 40;
const TABLE_MAX_LEN = 24;
const VALID_YEAR_MIN = 2000;
const VALID_YEAR_MAX = 2035;

// ---------- value helpers ----------

/** Money/number text -> integer cents (money) or NaN. Accepts $ , (neg) trailing-minus. */
export function parseCents(s) {
  const n = parseNumber(s);
  return Number.isNaN(n) ? NaN : Math.round(n * 100);
}

export function parseNumber(s) {
  let t = String(s).trim().replace(/[$,\s]/g, '');
  if (t === '') return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith('-')) {
    neg = !neg;
    t = t.slice(0, -1);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  const n = Number(t);
  return neg ? -n : n;
}

/** Parse m/d/y, y-m-d, yyyymmdd, mmddyyyy. Returns { y, m, d } (calendar-valid) or null. */
export function parseDate(s) {
  let m;
  let y;
  let mo;
  let d;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    mo = +m[1];
    d = +m[2];
    y = m[3].length === 2 ? (+m[3] < 70 ? 2000 + +m[3] : 1900 + +m[3]) : +m[3];
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else if ((m = /^(\d{8})$/.exec(s))) {
    const a = +m[1].slice(0, 4);
    if (a >= 1900 && a <= 2100) {
      y = a;
      mo = +m[1].slice(4, 6);
      d = +m[1].slice(6, 8);
    } else {
      mo = +m[1].slice(0, 2);
      d = +m[1].slice(2, 4);
      y = +m[1].slice(4, 8);
    }
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

const isoOf = ({ y, m, d }) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const shapeOf = (s) => s.slice(0, 24).replace(/\d/g, '9').replace(/[A-Za-z]/g, 'a');
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const usd = (cents) => Math.round(cents) / 100;
const bump = (map, k, n = 1) => map.set(k, (map.get(k) ?? 0) + n);

/** Frequency table, suppressed unless it looks like a categorical code column. */
function tableOf(map, { force = false } = {}) {
  const distinct = map.size;
  let maxLen = 0;
  for (const k of map.keys()) maxLen = Math.max(maxLen, k.length);
  if (!force && (distinct > TABLE_MAX_DISTINCT || maxLen > TABLE_MAX_LEN)) {
    return { distinct, suppressed: true };
  }
  return { distinct, values: Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1])) };
}

// ---------- per-column accumulator ----------

class ColStat {
  constructor(header, index, kind, tabulate = kind === 'cat' || kind === 'flag') {
    Object.assign(this, { header, index, kind, tabulate });
    this.nonEmpty = 0;
    this.counts = new Map();
    this.lenMin = Infinity;
    this.lenMax = 0;
    this.sumCents = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.minDate = null;
    this.maxDate = null;
    this.unparseable = 0;
    this.junkYears = new Map();
    this.shapes = new Map();
    this.negatives = 0;
    this.zeros = 0;
  }

  add(v) {
    if (v === '') return;
    this.nonEmpty++;
    bump(this.counts, v);
    if (v.length < this.lenMin) this.lenMin = v.length;
    if (v.length > this.lenMax) this.lenMax = v.length;
    switch (this.kind) {
      case 'date': {
        const p = parseDate(v);
        bump(this.shapes, shapeOf(v));
        if (!p) {
          this.unparseable++;
          bump(this.junkYears, 'unparseable');
        } else if (p.y < VALID_YEAR_MIN || p.y > VALID_YEAR_MAX) {
          bump(this.junkYears, String(p.y));
        } else {
          const iso = isoOf(p);
          if (!this.minDate || iso < this.minDate) this.minDate = iso;
          if (!this.maxDate || iso > this.maxDate) this.maxDate = iso;
        }
        break;
      }
      case 'money':
      case 'num':
      case 'pct': {
        const n = parseNumber(v);
        if (Number.isNaN(n)) {
          this.unparseable++;
          bump(this.shapes, shapeOf(v));
          break;
        }
        if (n < 0) this.negatives++;
        if (n === 0) this.zeros++;
        if (n < this.min) this.min = n;
        if (n > this.max) this.max = n;
        this.sum += n;
        this.sumCents += Math.round(n * 100);
        break;
      }
      default:
    }
  }

  result() {
    const r = { header: this.header, index: this.index, kind: this.kind, nonEmpty: this.nonEmpty, distinct: this.counts.size };
    if (this.nonEmpty) r.length = { min: this.lenMin, max: this.lenMax };
    if (this.kind === 'date') {
      Object.assign(r, { min: this.minDate, max: this.maxDate, outOfRangeOrJunkByYear: Object.fromEntries(this.junkYears), unparseable: this.unparseable });
      r.shapes = Object.fromEntries([...this.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
    } else if (this.kind === 'money' || this.kind === 'num' || this.kind === 'pct') {
      r.unparseable = this.unparseable;
      if (this.unparseable) r.unparseableShapes = Object.fromEntries([...this.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5));
      if (this.nonEmpty - this.unparseable) {
        Object.assign(r, { min: this.min, max: this.max, sum: this.kind === 'money' ? usd(this.sumCents) : Math.round(this.sum * 100) / 100, negatives: this.negatives, zeros: this.zeros });
      }
    }
    if (this.tabulate && this.nonEmpty) r.table = tableOf(this.counts);
    return r;
  }
}

// ---------- the profiler ----------

export function createProfiler(headers) {
  const groups = groupColumns(headers);
  for (const [g, n] of Object.entries(GROUP_COUNTS)) {
    if (groups[g].length !== n) throw new Error(`header layout mismatch: expected ${n} ${g} groups, found ${groups[g].length}`);
  }
  const sc = scalarColumns(headers, groups);
  const S = sc.byKey;

  const scalarStats = new Map();
  for (const [key, idx] of Object.entries(S)) scalarStats.set(key, new ColStat(headers[idx], idx, sc.kinds[key]));
  for (const u of sc.unknown) scalarStats.set(u.key, new ColStat(u.header, u.index, 'text'));

  // group accumulators ------------------------------------------------------
  const fieldKinds = {
    stops: { marker: 'tab', name: 'name', address: 'addr', city: 'addr', state: 'addr', zip: 'addr', phone: 'id', ref: 'id' },
    charges: { code: 'tab', description: 'text', units: 'text', weight: 'num', rate: 'num', extension: 'money' },
    accessorials: { charge: 'money', label: 'tab' },
    customerPayments: { date: 'date', amount: 'money', daysToPay: 'num', checkNo: 'id' },
    projectedExpenses: { expense: 'tab', amount: 'money', type: 'tab' },
    paidExpenses: { name: 'name', amount: 'money', date: 'date', checkNo: 'id', gl: 'tab' },
    commissions: { rep: 'tab', amt: 'money', source: 'tab', gnf: 'tab', pct: 'pct', flat: 'money', posted: 'text' },
    additionalRefs: { ref: 'id' },
  };
  const groupStats = {};
  for (const [g, kinds] of Object.entries(fieldKinds)) {
    groupStats[g] = groups[g].map((blk) => {
      const stats = {};
      for (const [f, idx] of Object.entries(blk.fields)) {
        const k = kinds[f];
        stats[f] = new ColStat(headers[idx], idx, k === 'tab' ? 'text' : k, k === 'tab');
      }
      return { ordinal: blk.ordinal, fields: stats, usedRows: 0 };
    });
  }
  const usedIdx = {
    stops: ['name', 'address', 'city', 'state', 'zip', 'phone', 'ref'],
    charges: ['code', 'description', 'rate', 'extension'],
    accessorials: ['charge', 'label'],
    customerPayments: ['date', 'amount', 'checkNo'],
    projectedExpenses: ['expense', 'amount'],
    paidExpenses: ['name', 'amount', 'date', 'checkNo', 'gl'],
    commissions: ['rep', 'amt', 'flat', 'pct'],
    additionalRefs: ['ref'],
  };
  const usedCountHist = {};
  for (const g of Object.keys(fieldKinds)) usedCountHist[g] = new Map();

  // cross-row aggregates ---------------------------------------------------
  let rows = 0;
  let dollarPlaceholders = 0;
  const rowLengths = new Map();
  const memo = { rows: 0, blankStatus: 0, blankMode: 0, noCarrier: 0, noPickup: 0, byType: new Map(), codes: new Map(), credits: 0, debits: 0, lh: 0, invoice: 0, bal: 0, payments: 0, withShipDate: 0 };
  const memoByType = {};
  const loads = { rows: 0, credits: 0, debits: 0, invoice: 0, balIdentityOk: 0, balIdentityBad: 0, balBadNoInvoiceDate: 0, balBadNoInvoiceDateInvoiceSum: 0, balBadWithInvoiceDate: 0, noInvoiceDate: 0, noInvoiceDateBalZero: 0, noInvoiceDateBalBlank: 0, noInvoiceDateInvoicePositive: 0, noInvoiceDateInvoiceSum: 0 };
  const agg = { accLabel: new Map(), accLabelSum: new Map(), chargeDesc7p: new Map(), chargeDesc7pSum: new Map(), projType2p: new Map(), projType2pSum: new Map(), paidGl: new Map(), paidGlSum: new Map(), commissionSource: new Map() };
  const batches = { arCheck: new Set(), arCheckCustDate: new Set(), arCheckCustomers: new Map(), arLines: 0, apCheck: new Set(), apCheckCarrierDate: new Set(), apCheckCarriers: new Map(), apLines: 0, apLinesNoCarrierId: 0 };
  const apx = { eq: 0, gt: 0, gtSum: 0, lt: 0, ltSum: 0, gtDelivered: 0, gtDeliveredSum: 0, gtVoidOrOpen: 0, noCarrierPaidZero: 0 };
  const proHash = new Map();
  let dupIdentical = 0;
  let dupDiffering = 0;
  const carrierIdToDot = new Map();
  const ivanExtra = { withActualDispatcher: 0, withAssignedDispatcher: 0, withServiceRep: 0 };
  let shortRows = 0;
  let longRows = 0;
  const width = headers.length;
  const pro = { empty: 0, seen: new Set(), dupRows: 0, dupValues: new Set(), nonNumeric: 0, nums: new Set(), min: Infinity, max: -Infinity, lens: new Map() };
  const chargeCodes = new Map();
  const chargeCodeExt = new Map();
  const chargeCodeOrd1 = new Map();
  const chargeFlags = { codeNoExt: 0, extNoCode: 0 };
  const ext = { rowsCompared: 0, equal: 0, mismatch: 0, netCents: 0, absCents: 0, rowsWithCharges: 0, rowsNoChargesButInvoice: 0 };
  const identities = {};
  const idn = (k, ok, applicable = true) => {
    const o = (identities[k] ??= { applicable: 0, equal: 0 });
    if (!applicable) return;
    o.applicable++;
    if (ok) o.equal++;
  };
  const crossStatus = new Map();
  const voidT = { rows: 0, lh: 0, accRev: 0, invoice: 0, bal: 0, chargeExt: 0, paymentsReceived: 0, actualCarrierExp: 0 };
  const paidVsBal = { paid1AndBalPositive: 0, paid1AndBalZero: 0, paid1AndBalNegative: 0, paid1AndBalEmpty: 0, noPaid1AndBalPositive: 0, noPaid1AndBalZeroOrLess_invoicePositive: 0, noPaid1AndBalEmpty_invoicePositive: 0, paid1NoPaidAmount1: 0, paidAmount1NoPaidDate1: 0 };
  const ivan = { rows: 0, withDriver: 0, drivers: new Set(), carrierIds: new Set(), lh: 0, invoice: 0, actualCarrierExp: 0, projectedCarrierExpense: 0, withTractor: 0, status: new Map(), mode: new Map(), withPaidExp: 0, withCommission: 0, revenueType: new Map(), typeOfShipment: new Map(), salesrep: new Map() };
  const revT = new Map();
  const typeT = new Map();
  const driverNotIvan = { rows: 0 };
  const sets = { customerId: new Set(), carrierId: new Set(), driverName: new Set(), carrierMc: new Set(), carrierDot: new Set(), carrierScac: new Set(), billToId: new Set(), carrierName: new Set(), customerName: new Set(), salesrepId: new Set() };
  const idToNames = { customer: new Map(), carrier: new Map() };
  const carrierIdToMc = new Map();
  const mcToIds = new Map();
  const carrierIdent = { rowsWithCarrierId: 0, rowsCarrierNameNoId: 0, idButNoMcDotScac: 0, idWithMc: 0, idWithDot: 0, idWithScac: 0, rowsNoCarrierAtAll: 0 };
  const cust = { rowsNoId: 0, rowsNoName: 0, billToDiffersFromCustomer: 0, billToEmpty: 0, masterEqualsPro: 0, masterNonEmpty: 0 };
  const dateRel = { shipAfterDelivered: 0, invoiceBeforeShip: 0, bothValid_ship_delivered: 0, bothValid_invoice_ship: 0 };
  const stopAgg = { multiStopRows: 0, zeroStopRows: 0, gapRows: 0, maxUsed: new Map(), pickupScalarNoStops: 0, pickupEqualsFirstStop: 0, consigneeEqualsLastStop: 0, consigneeScalarNoStops: 0, pickupScalarRows: 0, consigneeScalarRows: 0 };

  const money = (r, key) => {
    const i = S[key];
    if (i == null) return NaN;
    return parseCents((r[i] ?? '').trim());
  };
  // Aljex pads unused money slots with a bare "$"; treat as empty and count it.
  const cell = (r, i) => {
    const v = (r[i] ?? '').trim();
    if (v === '$') {
      dollarPlaceholders++;
      return '';
    }
    return v;
  };
  const get = (r, key) => (S[key] == null ? '' : cell(r, S[key]));
  const dateOk = (v) => {
    const p = parseDate(v);
    return p && p.y >= VALID_YEAR_MIN && p.y <= VALID_YEAR_MAX ? isoOf(p) : null;
  };

  function addRow(r) {
    rows++;
    bump(rowLengths, r.length);
    if (r.length < width) shortRows++;
    else if (r.length > width) longRows++;

    for (const st of scalarStats.values()) st.add(cell(r, st.index));

    // PRO #
    const proV = get(r, 'proNo');
    if (!proV) pro.empty++;
    else {
      const hsh = createHash('md5').update(r.join('\u0001')).digest('hex');
      if (pro.seen.has(proV)) {
        pro.dupRows++;
        pro.dupValues.add(proV);
        if (proHash.get(proV) === hsh) dupIdentical++;
        else dupDiffering++;
      } else proHash.set(proV, hsh);
      pro.seen.add(proV);
      bump(pro.lens, proV.length);
      if (/^\d+$/.test(proV)) {
        const n = Number(proV);
        pro.nums.add(n);
        if (n < pro.min) pro.min = n;
        if (n > pro.max) pro.max = n;
      } else pro.nonNumeric++;
    }

    // groups
    const used = {};
    for (const [g, list] of Object.entries(groupStats)) {
      let usedCount = 0;
      const flags = [];
      for (let k = 0; k < list.length; k++) {
        const blk = list[k];
        let any = false;
        for (const [f, st] of Object.entries(blk.fields)) {
          const v = cell(r, st.index);
          st.add(v);
          if (v && usedIdx[g].includes(f)) any = true;
        }
        flags.push(any);
        if (any) {
          blk.usedRows++;
          usedCount++;
        }
      }
      used[g] = flags;
      bump(usedCountHist[g], usedCount);
    }

    // stops
    const sFlags = used.stops;
    const nStops = sFlags.filter(Boolean).length;
    if (nStops > 1) stopAgg.multiStopRows++;
    if (nStops === 0) stopAgg.zeroStopRows++;
    let lastUsed = 0;
    let gap = false;
    for (let k = 0; k < sFlags.length; k++) {
      if (sFlags[k]) {
        if (lastUsed && k + 1 - lastUsed > 1) gap = true;
        else if (!lastUsed && k > 0) gap = true;
        lastUsed = k + 1;
      }
    }
    if (gap) stopAgg.gapRows++;
    bump(stopAgg.maxUsed, lastUsed);
    const pName = norm(get(r, 'pickupName'));
    const cName = norm(get(r, 'consigneeName'));
    const firstIdx = sFlags.indexOf(true);
    const stopName = (k) => norm(cell(r, groups.stops[k].fields.name));
    if (pName) {
      stopAgg.pickupScalarRows++;
      if (nStops === 0) stopAgg.pickupScalarNoStops++;
      else if (stopName(firstIdx) === pName) stopAgg.pickupEqualsFirstStop++;
    }
    if (cName) {
      stopAgg.consigneeScalarRows++;
      if (nStops === 0) stopAgg.consigneeScalarNoStops++;
      else if (stopName(lastUsed - 1) === cName) stopAgg.consigneeEqualsLastStop++;
    }

    // charges
    let sumExt = 0;
    let anyCharge = false;
    groups.charges.forEach((blk, k) => {
      const code = cell(r, blk.fields.code);
      const e = cell(r, blk.fields.extension);
      const c = e ? parseCents(e) : NaN;
      if (code) {
        bump(chargeCodes, code);
        if (k === 0) bump(chargeCodeOrd1, code);
        if (!e) chargeFlags.codeNoExt++;
      } else if (e) chargeFlags.extNoCode++;
      if (!Number.isNaN(c)) {
        sumExt += c;
        anyCharge = true;
        bump(chargeCodeExt, code || '(blank)', c);
      }
    });
    const invC = money(r, 'invoiceAmount');
    const lhC = money(r, 'lhRevenue');
    const accC = money(r, 'accRevenue');
    const fscC = money(r, 'fscRevenue');
    const balC = money(r, 'balDue');
    const n0 = (x) => (Number.isNaN(x) ? 0 : x);
    if (anyCharge) ext.rowsWithCharges++;
    if (anyCharge || !Number.isNaN(invC)) {
      ext.rowsCompared++;
      const diff = sumExt - n0(invC);
      if (diff === 0) ext.equal++;
      else {
        ext.mismatch++;
        ext.netCents += diff;
        ext.absCents += Math.abs(diff);
        if (!anyCharge) ext.rowsNoChargesButInvoice++;
      }
    }

    // payments / expenses sums
    let paidSum = 0;
    for (const blk of groups.customerPayments) paidSum += n0(parseCents(cell(r, blk.fields.amount)));
    let paidExpSum = 0;
    for (const blk of groups.paidExpenses) paidExpSum += n0(parseCents(cell(r, blk.fields.amount)));
    let projSum = 0;
    for (const blk of groups.projectedExpenses) projSum += n0(parseCents(cell(r, blk.fields.amount)));
    let accSum = 0;
    for (const blk of groups.accessorials) accSum += n0(parseCents(cell(r, blk.fields.charge)));
    const payRecC = money(r, 'paymentsReceived');
    const creditsC = money(r, 'credits');
    const debitsC = money(r, 'debits');

    // identities worth knowing for the mapping
    if (!Number.isNaN(invC)) {
      idn('invoiceAmount == sum(charge extensions)', invC === sumExt);
      idn('invoiceAmount == lhRevenue + accRevenue', invC === n0(lhC) + n0(accC));
      idn('invoiceAmount == lhRevenue + accRevenue + fscRevenue', invC === n0(lhC) + n0(accC) + n0(fscC));
      idn('invoiceAmount == lhRevenue + fscRevenue', invC === n0(lhC) + n0(fscC));
      idn('invoiceAmount == lhRevenue', invC === n0(lhC));
      if (!Number.isNaN(balC)) {
        idn('balDue == invoiceAmount - paymentsReceived', balC === invC - n0(payRecC));
        idn('balDue == invoiceAmount - sum(customer payments)', balC === invC - paidSum);
        idn('balDue == invoiceAmount - paymentsReceived - credits + debits', balC === invC - n0(payRecC) - n0(creditsC) + n0(debitsC));
        idn('balDue == invoiceAmount', balC === invC);
        idn('balDue == 0', balC === 0);
      }
    }
    if (!Number.isNaN(payRecC)) idn('paymentsReceived == sum(customer payments)', payRecC === paidSum);
    const actExpC = money(r, 'actualCarrierExp');
    if (!Number.isNaN(actExpC)) idn('actualCarrierExp == sum(paid carrier expenses)', actExpC === paidExpSum);
    const projCarrC = money(r, 'projectedCarrierExpense');
    if (!Number.isNaN(projCarrC)) idn('projectedCarrierExpense == sum(projected expenses)', projCarrC === projSum);
    const accRevC = accC;
    if (!Number.isNaN(accRevC)) idn('accRevenue == sum(accessorial charges)', accRevC === accSum);
    if (!Number.isNaN(lhC)) idn('lhRevenue == first charge extension', lhC === n0(parseCents(cell(r, groups.charges[0].fields.extension))));

    // descriptive-but-categorical aggregates (accessorial labels, charge-line text from line 7, projected types, GL)
    const addAgg = (cnt, sum, key, c) => {
      bump(cnt, key);
      if (!Number.isNaN(c)) bump(sum, key, c);
    };
    for (const blk of groups.accessorials) {
      const l = cell(r, blk.fields.label);
      if (l) addAgg(agg.accLabel, agg.accLabelSum, l, parseCents(cell(r, blk.fields.charge)));
    }
    groups.charges.forEach((blk, k) => {
      if (k < 6) return;
      const d = cell(r, blk.fields.description);
      const c = parseCents(cell(r, blk.fields.extension));
      if (d || !Number.isNaN(c)) addAgg(agg.chargeDesc7p, agg.chargeDesc7pSum, d || '(blank)', c);
    });
    groups.projectedExpenses.forEach((blk, k) => {
      if (k < 1) return;
      const t = cell(r, blk.fields.type);
      if (t) addAgg(agg.projType2p, agg.projType2pSum, t, parseCents(cell(r, blk.fields.amount)));
    });
    for (const blk of groups.paidExpenses) {
      const gl = cell(r, blk.fields.gl);
      if (gl) addAgg(agg.paidGl, agg.paidGlSum, gl, parseCents(cell(r, blk.fields.amount)));
    }

    const custId0 = get(r, 'customerId');
    const carId0 = get(r, 'carrierId');
    // check batches: how many loads share one check (AR) / one carrier check (AP)
    for (const blk of groups.customerPayments) {
      const ck = cell(r, blk.fields.checkNo);
      if (!ck && !cell(r, blk.fields.amount)) continue;
      batches.arLines++;
      batches.arCheck.add(ck);
      batches.arCheckCustDate.add(`${custId0}|${ck}|${cell(r, blk.fields.date)}`);
      let cs = batches.arCheckCustomers.get(ck);
      if (!cs) batches.arCheckCustomers.set(ck, (cs = new Set()));
      cs.add(custId0);
    }
    for (const blk of groups.paidExpenses) {
      const ck = cell(r, blk.fields.checkNo);
      if (!ck && !cell(r, blk.fields.amount)) continue;
      batches.apLines++;
      if (!carId0) batches.apLinesNoCarrierId++;
      batches.apCheck.add(ck);
      batches.apCheckCarrierDate.add(`${carId0}|${ck}|${cell(r, blk.fields.date)}`);
      let cs = batches.apCheckCarriers.get(ck);
      if (!cs) batches.apCheckCarriers.set(ck, (cs = new Set()));
      cs.add(carId0);
    }

    // memo (CRED/DEBT) rows vs loads
    const tos = get(r, 'typeOfShipment') || '(blank)';
    const isMemo = tos === 'CRED' || tos === 'DEBT';
    if (isMemo) {
      memo.rows++;
      const m = (memoByType[tos] ??= { rows: 0, credits: 0, debits: 0, lh: 0, invoice: 0, bal: 0, payments: 0, extSum: 0, blankStatus: 0, blankMode: 0, noCarrierId: 0, noPickup: 0, noConsignee: 0, withShipDate: 0, withInvoiceDate: 0, codes: new Map() });
      m.rows++;
      m.credits += n0(creditsC);
      m.debits += n0(debitsC);
      m.lh += n0(lhC);
      m.invoice += n0(invC);
      m.bal += n0(balC);
      m.payments += n0(payRecC);
      m.extSum += sumExt;
      if (!get(r, 'dispatchStatus')) m.blankStatus++;
      if (!get(r, 'mode')) m.blankMode++;
      if (!get(r, 'carrierId')) m.noCarrierId++;
      if (!get(r, 'pickupName')) m.noPickup++;
      if (!get(r, 'consigneeName')) m.noConsignee++;
      if (get(r, 'shipDate')) m.withShipDate++;
      if (get(r, 'invoiceDate')) m.withInvoiceDate++;
      groups.charges.forEach((blk) => {
        const c = cell(r, blk.fields.code);
        if (c) bump(m.codes, c);
      });
    } else {
      loads.rows++;
      loads.credits += n0(creditsC);
      loads.debits += n0(debitsC);
      loads.invoice += n0(invC);
      if (!get(r, 'invoiceDate')) {
        loads.noInvoiceDate++;
        if (balC === 0) loads.noInvoiceDateBalZero++;
        if (Number.isNaN(balC)) loads.noInvoiceDateBalBlank++;
        if (invC > 0) {
          loads.noInvoiceDateInvoicePositive++;
          loads.noInvoiceDateInvoiceSum += invC;
        }
      }
      if (!Number.isNaN(balC) && !Number.isNaN(invC)) {
        if (balC === invC - n0(payRecC) - n0(creditsC) + n0(debitsC)) loads.balIdentityOk++;
        else {
          loads.balIdentityBad++;
          if (!get(r, 'invoiceDate')) {
            loads.balBadNoInvoiceDate++;
            loads.balBadNoInvoiceDateInvoiceSum += invC;
          } else loads.balBadWithInvoiceDate++;
        }
      }
    }

    // status cross-tab
    const status = get(r, 'dispatchStatus') || '(blank)';
    let ct = crossStatus.get(status);
    if (!ct) crossStatus.set(status, (ct = { rows: 0, withInvoiceDate: 0, withShipDate: 0, withDeliveredDate: 0, withCarrierId: 0, withPaidDate1: 0, withStops: 0, invoiceAmount: 0, balDue: 0, lhRevenue: 0 }));
    ct.rows++;
    if (get(r, 'invoiceDate')) ct.withInvoiceDate++;
    if (get(r, 'shipDate')) ct.withShipDate++;
    if (get(r, 'deliveredDate')) ct.withDeliveredDate++;
    if (get(r, 'carrierId')) ct.withCarrierId++;
    if (cell(r, groups.customerPayments[0].fields.date)) ct.withPaidDate1++;
    if (nStops > 0) ct.withStops++;
    ct.invoiceAmount += n0(invC);
    ct.balDue += n0(balC);
    ct.lhRevenue += n0(lhC);

    if (!Number.isNaN(projCarrC) && !Number.isNaN(actExpC)) {
      if (projCarrC === actExpC) apx.eq++;
      else if (projCarrC > actExpC) {
        apx.gt++;
        apx.gtSum += projCarrC - actExpC;
        if (status === 'DELIVERED') {
          apx.gtDelivered++;
          apx.gtDeliveredSum += projCarrC - actExpC;
        } else apx.gtVoidOrOpen++;
      } else {
        apx.lt++;
        apx.ltSum += actExpC - projCarrC;
      }
    }
    // VOID
    if (/\bvoid/i.test(status)) {
      voidT.rows++;
      voidT.lh += n0(lhC);
      voidT.accRev += n0(accC);
      voidT.invoice += n0(invC);
      voidT.bal += n0(balC);
      voidT.chargeExt += sumExt;
      voidT.paymentsReceived += n0(payRecC);
      voidT.actualCarrierExp += n0(actExpC);
    }

    // paid vs bal
    const paid1 = cell(r, groups.customerPayments[0].fields.date);
    const paidAmt1 = cell(r, groups.customerPayments[0].fields.amount);
    if (paid1) {
      if (Number.isNaN(balC)) paidVsBal.paid1AndBalEmpty++;
      else if (balC > 0) paidVsBal.paid1AndBalPositive++;
      else if (balC === 0) paidVsBal.paid1AndBalZero++;
      else paidVsBal.paid1AndBalNegative++;
      if (!paidAmt1) paidVsBal.paid1NoPaidAmount1++;
    } else {
      if (balC > 0) paidVsBal.noPaid1AndBalPositive++;
      if (invC > 0 && balC <= 0) paidVsBal.noPaid1AndBalZeroOrLess_invoicePositive++;
      if (invC > 0 && Number.isNaN(balC)) paidVsBal.noPaid1AndBalEmpty_invoicePositive++;
      if (paidAmt1) paidVsBal.paidAmount1NoPaidDate1++;
    }

    // identities: customer / carrier / driver
    const custId = get(r, 'customerId');
    const custName = norm(get(r, 'customerName'));
    const carId = get(r, 'carrierId');
    const carNameRaw = get(r, 'carrierName');
    const carName = norm(carNameRaw);
    const driver = norm(get(r, 'driverName'));
    const mc = get(r, 'carrierMc');
    const dot = get(r, 'carrierDot');
    const scac = get(r, 'carrierScac');
    if (custId) sets.customerId.add(custId);
    else cust.rowsNoId++;
    if (!custName) cust.rowsNoName++;
    if (custName) sets.customerName.add(custName);
    if (custId && custName) {
      let s = idToNames.customer.get(custId);
      if (!s) idToNames.customer.set(custId, (s = new Set()));
      s.add(custName);
    }
    if (carId) {
      sets.carrierId.add(carId);
      carrierIdent.rowsWithCarrierId++;
      if (mc) carrierIdent.idWithMc++;
      if (dot) carrierIdent.idWithDot++;
      if (scac) carrierIdent.idWithScac++;
      if (!mc && !dot && !scac) carrierIdent.idButNoMcDotScac++;
      if (carName) {
        let s = idToNames.carrier.get(carId);
        if (!s) idToNames.carrier.set(carId, (s = new Set()));
        s.add(carName);
      }
      if (dot) {
        let s = carrierIdToDot.get(carId);
        if (!s) carrierIdToDot.set(carId, (s = new Set()));
        s.add(dot);
      }
      if (mc) {
        let s = carrierIdToMc.get(carId);
        if (!s) carrierIdToMc.set(carId, (s = new Set()));
        s.add(mc);
        let t = mcToIds.get(mc);
        if (!t) mcToIds.set(mc, (t = new Set()));
        t.add(carId);
      }
    } else if (carName) carrierIdent.rowsCarrierNameNoId++;
    else carrierIdent.rowsNoCarrierAtAll++;
    if (carName) sets.carrierName.add(carName);
    if (driver) sets.driverName.add(driver);
    if (mc) sets.carrierMc.add(mc);
    if (dot) sets.carrierDot.add(dot);
    if (scac) sets.carrierScac.add(scac);
    const btId = get(r, 'billToId');
    if (btId) sets.billToId.add(btId);
    if (!btId) cust.billToEmpty++;
    else if (btId !== custId) cust.billToDiffersFromCustomer++;
    const mi = get(r, 'masterInvoice');
    if (mi) {
      cust.masterNonEmpty++;
      if (mi === proV) cust.masterEqualsPro++;
    }
    const sr = get(r, 'salesrepId');
    if (sr) sets.salesrepId.add(sr);

    // Ivan Cartage
    if (carName.includes('ivan cartage')) {
      ivan.rows++;
      if (driver) {
        ivan.withDriver++;
        ivan.drivers.add(driver);
      }
      if (carId) ivan.carrierIds.add(carId);
      ivan.lh += n0(lhC);
      ivan.invoice += n0(invC);
      ivan.actualCarrierExp += n0(actExpC);
      ivan.projectedCarrierExpense += n0(projCarrC);
      if (get(r, 'tractorNo')) ivan.withTractor++;
      if (get(r, 'actualDispatcher')) ivanExtra.withActualDispatcher++;
      if (get(r, 'assignedDispatcher')) ivanExtra.withAssignedDispatcher++;
      if (get(r, 'serviceRep')) ivanExtra.withServiceRep++;
      bump(ivan.status, status);
      bump(ivan.mode, get(r, 'mode') || '(blank)');
      bump(ivan.revenueType, get(r, 'revenueType') || '(blank)');
      bump(ivan.typeOfShipment, get(r, 'typeOfShipment') || '(blank)');
      bump(ivan.salesrep, get(r, 'salesrepId') || '(blank)');
      if (used.paidExpenses.some(Boolean)) ivan.withPaidExp++;
      if (used.commissions.some(Boolean)) ivan.withCommission++;
    } else if (driver) driverNotIvan.rows++;

    for (const [m, key] of [[revT, get(r, 'revenueType') || '(blank)'], [typeT, tos]]) {
      let o = m.get(key);
      if (!o) m.set(key, (o = { rows: 0, ivanRows: 0, lhRevenue: 0, invoiceAmount: 0, balDue: 0, actualCarrierExp: 0, rowsWithCarrierId: 0 }));
      o.rows++;
      if (carName.includes('ivan cartage')) o.ivanRows++;
      o.lhRevenue += n0(lhC);
      o.invoiceAmount += n0(invC);
      o.balDue += n0(balC);
      o.actualCarrierExp += n0(actExpC);
      if (carId) o.rowsWithCarrierId++;
    }

    // date relations
    const sd = dateOk(get(r, 'shipDate'));
    const dd = dateOk(get(r, 'deliveredDate'));
    const idt = dateOk(get(r, 'invoiceDate'));
    if (sd && dd) {
      dateRel.bothValid_ship_delivered++;
      if (sd > dd) dateRel.shipAfterDelivered++;
    }
    if (sd && idt) {
      dateRel.bothValid_invoice_ship++;
      if (idt < sd) dateRel.invoiceBeforeShip++;
    }
  }

  function result() {
    const out = { rows, columns: width, rowsShorterThanHeader: shortRows, rowsLongerThanHeader: longRows };
    out.rowLengthHistogram = Object.fromEntries([...rowLengths.entries()].sort((a, b) => a[0] - b[0]));
    out.dollarSignOnlyPlaceholderCells = dollarPlaceholders;
    out.duplicateProRows = { identicalToFirst: dupIdentical, differingFromFirst: dupDiffering };
    out.memoRows = Object.fromEntries(Object.entries(memoByType).map(([k, m]) => [k, { rows: m.rows, credits: usd(m.credits), debits: usd(m.debits), lhRevenue: usd(m.lh), invoiceAmount: usd(m.invoice), balDue: usd(m.bal), paymentsReceived: usd(m.payments), chargeExtensionSum: usd(m.extSum), blankDispatchStatus: m.blankStatus, blankMode: m.blankMode, noCarrierId: m.noCarrierId, noPickupName: m.noPickup, noConsigneeName: m.noConsignee, withShipDate: m.withShipDate, withInvoiceDate: m.withInvoiceDate, chargeCodes: tableOf(m.codes) }]));
    out.loadRows = { rows: loads.rows, credits: usd(loads.credits), debits: usd(loads.debits), invoiceAmount: usd(loads.invoice), balIdentity_invoice_minus_payments_minus_credits_plus_debits: { equal: loads.balIdentityOk, notEqual: loads.balIdentityBad, notEqualAndNoInvoiceDate: loads.balBadNoInvoiceDate, notEqualAndNoInvoiceDate_invoiceAmountSum: usd(loads.balBadNoInvoiceDateInvoiceSum), notEqualButInvoiced: loads.balBadWithInvoiceDate }, rowsWithoutInvoiceDate: loads.noInvoiceDate, rowsWithoutInvoiceDateAndBalZero: loads.noInvoiceDateBalZero, rowsWithoutInvoiceDateAndBalBlank: loads.noInvoiceDateBalBlank, rowsWithoutInvoiceDateWithInvoiceAmountPositive: loads.noInvoiceDateInvoicePositive, invoiceAmountSumOnRowsWithoutInvoiceDate: usd(loads.noInvoiceDateInvoiceSum) };
    out.categoricalAggregates = { accessorialLabels: topTable(agg.accLabel, agg.accLabelSum), chargeLineDescriptionFromLine7: topTable(agg.chargeDesc7p, agg.chargeDesc7pSum), projectedExpenseTypeFromLine2: topTable(agg.projType2p, agg.projType2pSum), paidExpenseGl: topTable(agg.paidGl, agg.paidGlSum) };
    const multiSet = (m) => [...m.values()].filter((x) => x.size > 1).length;
    out.checkBatches = { arPaymentLines: batches.arLines, arDistinctCheckNumbers: batches.arCheck.size, arDistinctCustomerCheckDate: batches.arCheckCustDate.size, arCheckNumbersSpanningMoreThanOneCustomer: multiSet(batches.arCheckCustomers), apPaidExpenseLines: batches.apLines, apLinesWithoutCarrierId: batches.apLinesNoCarrierId, apDistinctCheckNumbers: batches.apCheck.size, apDistinctCarrierCheckDate: batches.apCheckCarrierDate.size, apCheckNumbersSpanningMoreThanOneCarrier: multiSet(batches.apCheckCarriers) };
    const fin = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1].rows - a[1].rows).map(([k, o]) => [k, { ...o, lhRevenue: usd(o.lhRevenue), invoiceAmount: usd(o.invoiceAmount), balDue: usd(o.balDue), actualCarrierExp: usd(o.actualCarrierExp) }]));
    out.byRevenueType = fin(revT);
    out.byTypeOfShipment = fin(typeT);
    out.apProjectedVsPaid = { rowsEqual: apx.eq, rowsProjectedGreater: apx.gt, projectedGreaterTotal: usd(apx.gtSum), ofWhichDeliveredRows: apx.gtDelivered, ofWhichDeliveredTotal: usd(apx.gtDeliveredSum), ofWhichNonDeliveredRows: apx.gtVoidOrOpen, rowsPaidGreater: apx.lt, paidGreaterTotal: usd(apx.ltSum) };
    out.groupCounts = Object.fromEntries(Object.keys(fieldKinds).map((g) => [g, groups[g].length]));

    // PRO
    const nums = [...pro.nums].sort((a, b) => a - b);
    let gaps = 0;
    for (let i = 1; i < nums.length; i++) gaps += nums[i] - nums[i - 1] - 1;
    out.proNo = {
      empty: pro.empty, distinct: pro.seen.size, duplicateRows: pro.dupRows, duplicatedValues: pro.dupValues.size, nonNumeric: pro.nonNumeric,
      min: nums.length ? nums[0] : null, max: nums.length ? nums[nums.length - 1] : null,
      missingNumbersInsideRange: gaps, lengthHistogram: Object.fromEntries([...pro.lens.entries()].sort((a, b) => a[0] - b[0])),
    };

    // groups
    out.groups = {};
    for (const [g, list] of Object.entries(groupStats)) {
      out.groups[g] = {
        blocksUsedHistogram: Object.fromEntries([...usedCountHist[g].entries()].sort((a, b) => a[0] - b[0])),
        byOrdinal: list.map((blk) => ({ ordinal: blk.ordinal, rowsUsed: blk.usedRows, fields: Object.fromEntries(Object.entries(blk.fields).map(([f, st]) => [f, st.result()])) })),
      };
    }
    out.stops = {
      multiStopRows: stopAgg.multiStopRows, zeroStopRows: stopAgg.zeroStopRows, rowsWithGapInStopOrdinals: stopAgg.gapRows,
      highestOrdinalUsedHistogram: Object.fromEntries([...stopAgg.maxUsed.entries()].sort((a, b) => a[0] - b[0])),
      scalarPickup: { rows: stopAgg.pickupScalarRows, noStopBlocks: stopAgg.pickupScalarNoStops, equalsFirstStopName: stopAgg.pickupEqualsFirstStop },
      scalarConsignee: { rows: stopAgg.consigneeScalarRows, noStopBlocks: stopAgg.consigneeScalarNoStops, equalsLastStopName: stopAgg.consigneeEqualsLastStop },
    };
    out.charges = {
      codeFrequency: tableOf(chargeCodes),
      codeFrequencyOrdinal1: tableOf(chargeCodeOrd1),
      extensionSumByCode: Object.fromEntries([...chargeCodeExt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, usd(v)]).slice(0, TABLE_MAX_DISTINCT)),
      codeWithoutExtension: chargeFlags.codeNoExt, extensionWithoutCode: chargeFlags.extNoCode,
    };
    out.chargeExtensionVsInvoice = {
      rowsCompared: ext.rowsCompared, rowsEqual: ext.equal, rowsMismatch: ext.mismatch,
      netDifference_sumExtMinusInvoice: usd(ext.netCents), absoluteDifferenceSum: usd(ext.absCents),
      rowsWithChargeLines: ext.rowsWithCharges, mismatchRowsWithNoChargeLines: ext.rowsNoChargesButInvoice,
    };
    out.identities = identities;

    // scalars
    out.scalars = Object.fromEntries([...scalarStats.entries()].map(([k, st]) => [k, st.result()]));
    const money_ = (k) => (scalarStats.get(k) ? scalarStats.get(k).result().sum ?? null : null);
    out.reconciliationTotals = { lhRevenue: money_('lhRevenue'), invoiceAmount: money_('invoiceAmount'), balDue: money_('balDue'), accRevenue: money_('accRevenue'), fscRevenue: money_('fscRevenue'), paymentsReceived: money_('paymentsReceived'), actualCarrierExp: money_('actualCarrierExp'), projectedCarrierExpense: money_('projectedCarrierExpense') };
    out.sumsByGroup = {};
    for (const [g, list] of Object.entries(groupStats)) {
      const f = { charges: 'extension', accessorials: 'charge', customerPayments: 'amount', projectedExpenses: 'amount', paidExpenses: 'amount', commissions: 'amt' }[g];
      if (!f) continue;
      const per = list.map((blk) => blk.fields[f].result().sum ?? 0);
      out.sumsByGroup[g] = { field: f, byOrdinal: per.map((x) => Math.round(x * 100) / 100), total: Math.round(per.reduce((a, b) => a + b, 0) * 100) / 100 };
    }
    const flat = groupStats.commissions.map((blk) => blk.fields.flat?.result().sum ?? 0);
    out.sumsByGroup.commissionFlat = { byOrdinal: flat, total: Math.round(flat.reduce((a, b) => a + b, 0) * 100) / 100 };

    out.statusCrossTab = tableOfStatus(crossStatus);
    out.void = { rows: voidT.rows, lhRevenue: usd(voidT.lh), accRevenue: usd(voidT.accRev), invoiceAmount: usd(voidT.invoice), balDue: usd(voidT.bal), chargeExtensions: usd(voidT.chargeExt), paymentsReceived: usd(voidT.paymentsReceived), actualCarrierExp: usd(voidT.actualCarrierExp) };
    out.paidDate1VsBalDue = paidVsBal;
    out.ivanCartage = {
      matchRule: 'normalized Carrier Name contains "ivan cartage"', rows: ivan.rows, rowsWithDriverName: ivan.withDriver,
      distinctDriverNames: ivan.drivers.size, distinctCarrierIds: ivan.carrierIds.size, withTractor: ivan.withTractor,
      withPaidCarrierExpense: ivan.withPaidExp, withCommission: ivan.withCommission,
      lhRevenue: usd(ivan.lh), invoiceAmount: usd(ivan.invoice), actualCarrierExp: usd(ivan.actualCarrierExp), projectedCarrierExpense: usd(ivan.projectedCarrierExpense),
      statusTable: tableOf(ivan.status), modeTable: tableOf(ivan.mode),
      revenueTypeTable: tableOf(ivan.revenueType), typeOfShipmentTable: tableOf(ivan.typeOfShipment), salesrepTable: tableOf(ivan.salesrep),
      rowsWithDriverNameButNotIvan: driverNotIvan.rows,
      withActualDispatcher: ivanExtra.withActualDispatcher, withAssignedDispatcher: ivanExtra.withAssignedDispatcher, withServiceRep: ivanExtra.withServiceRep,
    };
    const multi = (m) => [...m.values()].filter((s) => s.size > 1).length;
    out.distinctCounts = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.size]));
    out.identityAmbiguity = {
      customerIdsWithMoreThanOneName: multi(idToNames.customer), carrierIdsWithMoreThanOneName: multi(idToNames.carrier),
      carrierIdsWithMoreThanOneMc: multi(carrierIdToMc), carrierIdsWithMoreThanOneDot: multi(carrierIdToDot), mcsWithMoreThanOneCarrierId: multi(mcToIds),
    };
    out.carrierIdentity = carrierIdent;
    out.customerIdentity = cust;
    out.dateRelations = dateRel;
    return out;
  }

  return { addRow, result, headers: headers.length };
}

/** Top-N table for descriptive-but-categorical text (accessorial labels etc.): values > 32 chars are excluded and counted. */
function topTable(cnt, sums, n = TABLE_MAX_DISTINCT, maxLen = 32) {
  const rows = [];
  let excluded = 0;
  for (const [k, v] of cnt) {
    if (k.length > maxLen) excluded += v;
    else rows.push([k, v]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  return {
    distinct: cnt.size,
    shown: Math.min(n, rows.length),
    excludedLongValueCount: excluded,
    values: Object.fromEntries(rows.slice(0, n).map(([k, v]) => [k, { count: v, sum: sums.has(k) ? usd(sums.get(k)) : null }])),
  };
}

function tableOfStatus(map) {
  if (map.size > TABLE_MAX_DISTINCT) return { distinct: map.size, suppressed: true };
  const r = {};
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    if (k.length > TABLE_MAX_LEN) return { distinct: map.size, suppressed: true };
    r[k] = { ...v, invoiceAmount: usd(v.invoiceAmount), balDue: usd(v.balDue), lhRevenue: usd(v.lhRevenue) };
  }
  return { distinct: map.size, values: r };
}

// ---------- CLI ----------

export async function profileFile(csvPath, { onProgress } = {}) {
  let profiler = null;
  let headerRow = null;
  const parser = createCsvParser((row) => {
    if (!headerRow) {
      headerRow = row;
      profiler = createProfiler(row);
      return;
    }
    if (row.length === 1 && row[0] === '') return; // blank line
    profiler.addRow(row);
  });
  const decoder = new StringDecoder('utf8');
  let n = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(csvPath, { highWaterMark: 1 << 20 });
    s.on('data', (buf) => {
      parser.write(decoder.write(buf));
      n += buf.length;
      if (onProgress) onProgress(n);
    });
    s.on('end', resolve);
    s.on('error', reject);
  });
  parser.write(decoder.end());
  parser.end();
  if (!profiler) throw new Error('empty file');
  return { ...profiler.result(), file: { name: path.basename(csvPath), bytes: n } };
}

function parseArgs(argv) {
  const a = { csv: DEFAULT_CSV, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i].startsWith('--out=')) a.out = argv[i].slice(6);
    else a.csv = argv[i];
  }
  return a;
}

export function assertOutsideRepo(p) {
  const abs = path.resolve(p);
  const rel = path.relative(REPO_ROOT, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`--out must be outside the repo (${REPO_ROOT}); got ${abs}`);
  }
  return abs;
}

async function main() {
  const { csv, out } = parseArgs(process.argv.slice(2));
  const outAbs = out ? assertOutsideRepo(out) : null;
  const csvAbs = path.resolve(csv);
  if (!path.relative(REPO_ROOT, csvAbs).startsWith('..')) throw new Error('refusing to read a CSV inside the repo');
  let last = 0;
  const result = await profileFile(csvAbs, {
    onProgress: (bytes) => {
      if (bytes - last > 4 << 20) {
        last = bytes;
        process.stderr.write(`read ${(bytes / 1048576).toFixed(1)} MiB\n`);
      }
    },
  });
  const json = JSON.stringify(result, null, 2);
  if (outAbs) fs.writeFileSync(outAbs, json + '\n');
  process.stdout.write(json + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
