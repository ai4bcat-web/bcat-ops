// Column dictionary for the Aljex full-export CSV (486 columns, one row per load).
//
// Pure: takes the header row (array of strings), returns column indexes. No I/O,
// no row values. The layout is positional + repeated (stop blocks PS1..PS12, 21
// charge lines, ...), so everything is discovered from the header names.

/** Lower-case, apostrophes dropped, '#'->' no ', '%'->' pct ', '$'->' usd ', other non-alnum -> space. */
export function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/#/g, ' no ')
    .replace(/%/g, ' pct ')
    .replace(/\$/g, ' usd ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// kind: id | name | addr | text | staff | cat | flag | date | time | money | num | pct
// (only `cat`/`flag` columns are ever value-tabulated by the profiler; staff/name/addr/text/id never)
export const SCALAR_SPECS = [
  ['office', 'office', 'cat'],
  ['pro no', 'proNo', 'id'],
  ['master invoice', 'masterInvoice', 'id'],
  ['customer account no', 'customerId', 'id'],
  ['customer name', 'customerName', 'name'],
  ['customer address', 'customerAddress', 'addr'],
  ['customer city', 'customerCity', 'addr'],
  ['customer state', 'customerState', 'addr'],
  ['customer zip', 'customerZip', 'addr'],
  ['type of shipment', 'typeOfShipment', 'cat'],
  ['tonu', 'tonu', 'cat'],
  ['salesrep id', 'salesrepId', 'cat'],
  ['reference no', 'referenceNo', 'id'],
  ['dispatch status', 'dispatchStatus', 'cat'],
  ['invoice date', 'invoiceDate', 'date'],
  ['ship date', 'shipDate', 'date'],
  ['eta date', 'etaDate', 'date'],
  ['delivery appt date', 'deliveryApptDate', 'date'],
  ['delivery appt time', 'deliveryApptTime', 'time'],
  ['deliver appt note', 'deliverApptNote', 'text'],
  ['must deliver date', 'mustDeliverDate', 'date'],
  ['delivered date', 'deliveredDate', 'date'],
  ['posted info', 'postedInfo', 'text'],
  ['bill to account', 'billToId', 'id'],
  ['bill to name', 'billToName', 'name'],
  ['bill to address', 'billToAddress', 'addr'],
  ['bill to city', 'billToCity', 'addr'],
  ['bill to state', 'billToState', 'addr'],
  ['bill to zip', 'billToZip', 'addr'],
  ['pickup name', 'pickupName', 'name'],
  ['pickup city', 'pickupCity', 'addr'],
  ['pickup state', 'pickupState', 'addr'],
  ['pickup zip', 'pickupZip', 'addr'],
  ['consignee name', 'consigneeName', 'name'],
  ['consignee city', 'consigneeCity', 'addr'],
  ['consignee state', 'consigneeState', 'addr'],
  ['consignee zip', 'consigneeZip', 'addr'],
  ['line haul carrier id', 'carrierId', 'id'],
  ['carrier name', 'carrierName', 'name'],
  ['carrier ref no', 'carrierRefNo', 'id'],
  ['carrier dispatcher', 'carrierDispatcher', 'name'],
  ['description', 'commodity', 'text'],
  ['weight', 'weight', 'num'],
  ['footage', 'footage', 'num'],
  ['manifest', 'manifest', 'text'],
  ['customer ref no', 'customerRefNo', 'id'],
  ['container no', 'containerNo', 'id'],
  ['miles class', 'miles', 'num'],
  ['entered', 'enteredBy', 'staff'],
  ['covered', 'coveredBy', 'staff'],
  ['revenue type', 'revenueType', 'cat'],
  ['lh revenue', 'lhRevenue', 'money'],
  ['acc revenue', 'accRevenue', 'money'],
  ['projected carrier expense', 'projectedCarrierExpense', 'money'],
  ['carrier lh', 'carrierLh', 'money'],
  ['carrier accessorial', 'carrierAccessorial', 'money'],
  ['projected gross profit', 'projectedGrossProfit', 'money'],
  ['projected profit pct', 'projectedProfitPct', 'pct'],
  ['payments received', 'paymentsReceived', 'money'],
  ['actual carrier exp', 'actualCarrierExp', 'money'],
  ['accessorial profit', 'accessorialProfit', 'money'],
  ['credits', 'credits', 'money'],
  ['debits', 'debits', 'money'],
  ['bal due', 'balDue', 'money'],
  ['projected l h profit', 'projectedLhProfit', 'money'],
  ['advance fees', 'advanceFees', 'money'],
  ['quick pay fees', 'quickPayFees', 'money'],
  ['osd y n', 'osd', 'flag'],
  ['mode', 'mode', 'cat'],
  ['release date', 'releaseDate', 'date'],
  ['release time', 'releaseTime', 'time'],
  ['release by', 'releaseBy', 'staff'],
  ['billed by', 'billedBy', 'staff'],
  ['fsc revenue', 'fscRevenue', 'money'],
  ['invoice amount', 'invoiceAmount', 'money'],
  ['benchmark', 'benchmark', 'text'],
  ['lead source', 'leadSource', 'text'],
  ['quote no', 'quoteNo', 'id'],
  ['origin region', 'originRegion', 'cat'],
  ['destination region', 'destinationRegion', 'cat'],
  ['hazmat', 'hazmat', 'flag'],
  ['temp control', 'tempControl', 'flag'],
  ['seal', 'seal', 'id'],
  ['plt exchange', 'pltExchange', 'flag'],
  ['plt in', 'pltIn', 'num'],
  ['plt out', 'pltOut', 'num'],
  ['blind', 'blind', 'flag'],
  ['customs bond', 'customsBond', 'flag'],
  ['declared value', 'declaredValue', 'money'],
  ['escort', 'escort', 'flag'],
  ['high risk', 'highRisk', 'flag'],
  ['hot', 'hot', 'flag'],
  ['labor', 'labor', 'flag'],
  ['over size', 'overSize', 'flag'],
  ['permit', 'permit', 'flag'],
  ['tarps', 'tarps', 'flag'],
  ['tarp size', 'tarpSize', 'text'],
  ['team', 'team', 'flag'],
  ['smartway', 'smartway', 'flag'],
  ['created by', 'createdBy', 'staff'],
  ['created date', 'createdDate', 'date'],
  ['created time', 'createdTime', 'time'],
  ['pick up address', 'pickUpAddress', 'addr'],
  ['final consignee address', 'finalConsigneeAddress', 'addr'],
  ['carrier email', 'carrierEmail', 'text'],
  ['tractor no', 'tractorNo', 'id'],
  ['driver name', 'driverName', 'name'],
  ['carrier mc no prefix', 'carrierMcPrefix', 'cat'],
  ['carrier mc no', 'carrierMc', 'id'],
  ['carrier dot no', 'carrierDot', 'id'],
  ['carrier scac code', 'carrierScac', 'id'],
  ['carrier ca intrastate', 'carrierCaIntrastate', 'id'],
  ['carrier ca intrastate exp', 'carrierCaIntrastateExp', 'date'],
  ['carrier tx puc no', 'carrierTxPuc', 'id'],
  ['carrier tx puc no exp', 'carrierTxPucExp', 'date'],
  ['carrier safety rating', 'carrierSafetyRating', 'cat'],
  ['mexican authority y n', 'mexicanAuthority', 'flag'],
  ['canadian authority y n', 'canadianAuthority', 'flag'],
  ['covered date', 'coveredDate', 'date'],
  ['covered time', 'coveredTime', 'time'],
  ['office covered by', 'officeCoveredBy', 'staff'],
  ['customer contact', 'customerContact', 'name'],
  ['pickup contact', 'pickupContact', 'name'],
  ['consignee contact', 'consigneeContact', 'name'],
  ['currency', 'currency', 'cat'],
  ['conf recd date', 'confRecdDate', 'date'],
  ['conf recd time', 'confRecdTime', 'time'],
  ['service rep', 'serviceRep', 'staff'],
  ['assigned dispatcher', 'assignedDispatcher', 'staff'],
  ['actual dispatcher', 'actualDispatcher', 'staff'],
  ['pickup ref no', 'pickupRefNo', 'id'],
  ['consignee ref no', 'consigneeRefNo', 'id'],
  ['carrier phone', 'carrierPhone', 'text'],
  ['carrier dispatch phone', 'carrierDispatchPhone', 'text'],
  ['carrier 24 hr phone', 'carrier24HrPhone', 'text'],
  ['carrier email 1', 'carrierEmail1', 'text'],
  ['carier email 2', 'carrierEmail2', 'text'],
];

const SPEC_BY_NORM = new Map(SCALAR_SPECS.map(([n, key, kind]) => [n, { key, kind }]));

const STOP_FIELDS = ['marker', 'name', 'address', 'city', 'state', 'zip', 'phone', 'ref'];
const STOP_PATTERNS = [
  /^ps\d*$/,
  /^name$/,
  /^address$/,
  /^city$/,
  /^state$/,
  /^zip$/,
  /^phone$/,
  /^ref( no)?$/,
];
const CHARGE_FIELDS = ['code', 'description', 'units', 'weight', 'rate', 'extension'];
const CHARGE_PATTERNS = [
  /^code$/,
  /^description$/,
  /units/,
  /^weight$/,
  /^rate$/,
  /^extension$/,
];
const PAID_EXP_FIELDS = ['name', 'amount', 'date', 'checkNo', 'gl'];
const PAID_EXP_PATTERNS = [
  /^paid exp name$/,
  /^paid exp amt$/,
  /^paid exp date$/,
  /^paid exp ck no$/,
  /^paid exp gl$/,
];

/** Match a run of consecutive headers against ordered patterns. Returns index array or null. */
function matchRun(norm, start, patterns, required) {
  const idx = [];
  for (let k = 0; k < patterns.length; k++) {
    const i = start + k;
    if (i < norm.length && patterns[k].test(norm[i])) idx.push(i);
    else if (k < required) return null;
    else break;
  }
  return idx;
}

function toFields(names, idx) {
  const f = {};
  for (let k = 0; k < idx.length; k++) f[names[k]] = idx[k];
  return f;
}

function commissionField(norm) {
  if (/^commission rep \d+$/.test(norm)) return 'rep';
  if (/^commission amt \d+$/.test(norm)) return 'amt';
  if (/^commission (created from|isp) \d+$/.test(norm)) return 'source';
  if (/^commis(sion)? gnf \d+$/.test(norm)) return 'gnf';
  if (/^commis(sion)? pct \d+$/.test(norm)) return 'pct';
  if (/^commis(sion)? flat usd \d+$/.test(norm)) return 'flat';
  if (/^posted commis(sion)? \d+$/.test(norm)) return 'posted';
  return null;
}

function numbered(norm, re) {
  const m = re.exec(norm);
  return m ? Number(m[1]) : null;
}

/**
 * Index of repeated groups by ordinal (1-based, ordered by position, except the
 * numbered families — accessorial/payment/projected/commission — which use the
 * number in the header).
 *
 * Returns arrays of `{ ordinal, start, end, fields: { fieldName: columnIndex } }`.
 */
export function groupColumns(headers) {
  const norm = headers.map(normalizeHeader);
  const claimed = new Set();
  const out = {
    stops: [],
    charges: [],
    accessorials: [],
    customerPayments: [],
    projectedExpenses: [],
    paidExpenses: [],
    commissions: [],
    additionalRefs: [],
  };
  const claim = (idx) => idx.forEach((i) => claimed.add(i));
  const byNumber = (map, n, field, i) => {
    if (!map.has(n)) map.set(n, {});
    map.get(n)[field] = i;
    claimed.add(i);
  };
  const acc = new Map();
  const pay = new Map();
  const proj = new Map();
  const com = new Map();

  for (let i = 0; i < norm.length; i++) {
    const h = norm[i];
    if (STOP_PATTERNS[0].test(h)) {
      const idx = matchRun(norm, i, STOP_PATTERNS, 6);
      if (idx) {
        out.stops.push({ ordinal: out.stops.length + 1, start: idx[0], end: idx[idx.length - 1], fields: toFields(STOP_FIELDS, idx) });
        claim(idx);
        i = idx[idx.length - 1];
        continue;
      }
    }
    if (h === 'code') {
      const idx = matchRun(norm, i, CHARGE_PATTERNS, 6);
      if (idx) {
        out.charges.push({ ordinal: out.charges.length + 1, start: idx[0], end: idx[5], fields: toFields(CHARGE_FIELDS, idx) });
        claim(idx);
        i = idx[5];
        continue;
      }
    }
    if (h === 'paid exp name') {
      const idx = matchRun(norm, i, PAID_EXP_PATTERNS, 4);
      if (idx) {
        out.paidExpenses.push({ ordinal: out.paidExpenses.length + 1, start: idx[0], end: idx[idx.length - 1], fields: toFields(PAID_EXP_FIELDS, idx) });
        claim(idx);
        i = idx[idx.length - 1];
        continue;
      }
    }
    if (h === 'additional ref no') {
      out.additionalRefs.push({ ordinal: out.additionalRefs.length + 1, start: i, end: i, fields: { ref: i } });
      claimed.add(i);
      continue;
    }
    let n;
    if ((n = numbered(h, /^acc charge (\d+)$/)) != null) byNumber(acc, n, 'charge', i);
    else if ((n = numbered(h, /^acc (\d+)$/)) != null) byNumber(acc, n, 'label', i);
    else if ((n = numbered(h, /^paid date (\d+)$/)) != null) byNumber(pay, n, 'date', i);
    else if ((n = numbered(h, /^paid amount (\d+)$/)) != null) byNumber(pay, n, 'amount', i);
    else if ((n = numbered(h, /^days to pay (\d+)$/)) != null) byNumber(pay, n, 'daysToPay', i);
    else if ((n = numbered(h, /^paid ck no (\d+)$/)) != null) byNumber(pay, n, 'checkNo', i);
    else if ((n = numbered(h, /^proj exp (\d+)$/)) != null) byNumber(proj, n, 'expense', i);
    else if ((n = numbered(h, /^proj amt (\d+)$/)) != null) byNumber(proj, n, 'amount', i);
    else if ((n = numbered(h, /^type (\d+)$/)) != null) byNumber(proj, n, 'type', i);
    else {
      const cf = commissionField(h);
      if (cf) byNumber(com, numbered(h, /(\d+)$/), cf, i);
    }
  }

  const fromMap = (map, target) => {
    for (const [n, fields] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
      const idx = Object.values(fields);
      target.push({ ordinal: n, start: Math.min(...idx), end: Math.max(...idx), fields });
    }
  };
  fromMap(acc, out.accessorials);
  fromMap(pay, out.customerPayments);
  fromMap(proj, out.projectedExpenses);
  fromMap(com, out.commissions);

  out.claimed = claimed;
  return out;
}

/**
 * Scalar (non-group) columns. `byKey` maps known keys to a column index,
 * `kinds` maps key -> kind, `unknown` lists ungrouped columns without a spec
 * (e.g. the repeated "Future Use" placeholders) as `{ index, header, key }`.
 */
export function scalarColumns(headers, groups = groupColumns(headers)) {
  const byKey = {};
  const kinds = {};
  const unknown = [];
  const seen = new Map();
  for (let i = 0; i < headers.length; i++) {
    if (groups.claimed.has(i)) continue;
    const n = normalizeHeader(headers[i]);
    const spec = SPEC_BY_NORM.get(n);
    const first = !seen.has(n);
    seen.set(n, (seen.get(n) ?? 0) + 1);
    if (spec && first) {
      byKey[spec.key] = i;
      kinds[spec.key] = spec.kind;
    } else {
      const slug = n.replace(/ (\w)/g, (_, c) => c.toUpperCase()) || `col${i}`;
      unknown.push({ index: i, header: headers[i], key: `${slug}${seen.get(n)}` });
    }
  }
  return { byKey, kinds, unknown };
}

export const GROUP_COUNTS = {
  stops: 12,
  charges: 21,
  accessorials: 8,
  customerPayments: 3,
  projectedExpenses: 9,
  paidExpenses: 8,
  commissions: 3,
};
