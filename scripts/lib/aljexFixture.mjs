// Synthetic generator for the 486-column Aljex full export. SYNTHETIC ONLY: every name is drawn
// from word lists and prefixed `ZZ `, PROs live in the reserved band 900000-999999, there is no
// real value anywhere. The header names come from src/lib/aljex/headers.json (schema only) and
// the column positions are discovered with scripts/lib/aljexColumns.mjs, i.e. independently of
// the typed mapper under test. The returned `oracle` is computed from this generator's own model
// (not from the importer), so a test that compares engine output to it is a real check.
//
//   generateAljex({ rows, seed, anomalies: 'none' | 'standard' | 'all' }) -> { headers, rows, oracle }
//   renderAljexCsv(result, { bom, crlf, delimiter }) -> string
//
// anomalies: 'none' = clean data only; 'standard' (default) = every non-blocking anomaly (duplicates,
// junk dates, odd statuses, unicode, money formats, ...); 'all' = standard + the ones that must block
// or error (unknown status, non-numeric/derived/over-long PRO, a row longer than the header, a
// charge-sum mismatch) and therefore break the "synthetic band" guard on purpose.
import { readFileSync } from 'node:fs';
import { groupColumns, scalarColumns } from './aljexColumns.mjs';

export const ALJEX_HEADERS = JSON.parse(
  readFileSync(new URL('../../src/lib/aljex/headers.json', import.meta.url), 'utf8'),
);

const WORDS_A = ['Blue', 'Iron', 'Maple', 'Summit', 'Prairie', 'Harbor', 'Cedar', 'Copper', 'Falcon', 'Granite', 'Lakeside', 'Metro', 'Northern', 'Orchard', 'Pioneer', 'Quarry', 'Ridge', 'Sterling', 'Timber', 'Union'];
const WORDS_B = ['Supply', 'Foods', 'Paper', 'Metals', 'Plastics', 'Goods', 'Industries', 'Brands', 'Mills', 'Parts', 'Chemical', 'Textile', 'Pallets', 'Packaging', 'Beverage'];
const SUFFIX = ['Co', 'LLC', 'Inc', 'Group', 'Works'];
const STREETS = ['Main St', 'Oak Ave', 'Industrial Pkwy', 'Commerce Dr', 'Mill Rd', 'Depot St', 'Lake Blvd', 'Elm Way'];
const CITIES = [['Chicago', 'IL', '60601'], ['Joliet', 'IL', '60431'], ['Gary', 'IN', '46402'], ['Memphis', 'TN', '38103'], ['Dallas', 'TX', '75201'], ['Atlanta', 'GA', '30301'], ['Columbus', 'OH', '43215'], ['Kansas City', 'MO', '64101'], ['Denver', 'CO', '80202'], ['Omaha', 'NE', '68102']];
const FIRST = ['Alex', 'Sam', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Taylor', 'Jamie'];
const LAST = ['Stone', 'Reed', 'Hart', 'Cole', 'Vale', 'Frost', 'Lane', 'Moss'];
const COMMODITY = ['PALLETS OF PAPER', 'CANNED GOODS', 'STEEL COILS', 'PLASTIC RESIN', 'FROZEN FOOD', 'AUTO PARTS', 'LUMBER', 'MIXED FREIGHT'];
const ACC = ['DETENTION', 'CHASSIS', 'LUMPER FEE', 'STOP OFF CHARGE', 'LAYOVER', 'STORAGE CHARGES', 'MISCELLANEOUS', 'TRUCK ORDERED & NOT USED', 'ZZ ODD ACCESSORIAL'];
const PROJ_TYPES = ['FUEL', 'MAC', 'CHAS', 'STOR', 'DETN', 'MISC', 'STOP', 'LAYO'];
const TYPES = ['FTL', 'TL', 'LTL', 'AIR', 'OCN', 'V', 'R', 'STRA', 'ZAK', 'F'];
const STAFF = ['AA', 'BB', 'CC', 'DD'];
const REPS = ['001', '002', '003', '005', '10'];
const PROMOTED_FLAGS = ['hazmat', 'tempControl', 'team', 'tarps', 'escort', 'overSize', 'permit', 'blind', 'customsBond', 'pltExchange', 'labor', 'highRisk', 'smartway'];

export const SYNTH_PRO_MIN = 900000;
export const SYNTH_PRO_MAX = 999999;
export const IVAN_NAME = 'ZZ Ivan Cartage';

// ---------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Integer cents -> `1234.50` (no float). */
export function dollars(cents) {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${pad(a % 100)}`;
}

const dayNumber = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};
const fromDayNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const addDays = (iso, n) => fromDayNumber(dayNumber(iso) + n);
/** YYYY-MM-DD -> MM/DD/YY (the export's format). */
const us = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}` : '');

// ---------------------------------------------------------------------------------------------
// Forced scenario schedule: the first loads exercise every scenario once so even a 40-row fixture
// covers them; later loads draw from the weighted base mix.
const FORCED_STANDARD = [
  'PAID', 'PARTIAL', 'UNPAID', 'OVERPAID', 'TWO_PAYMENTS', 'CREDIT', 'DEBIT', 'UNINVOICED_DELIVERED', 'IVAN',
  'VOID', 'VOID_WEB', 'CONSIGNEE', 'COVERED', 'OPEN', 'LOADED', 'DISPATCHED', 'JUNK_70', 'JUNK_20', 'JUNK_23',
  'JUNK_BLANK', 'SHIP_AFTER_DELIVERED', 'STATUS_LOWER', 'STATUS_TRAILING', 'BLANK_CUSTOMER_VOID', 'MULTI_STOP',
  'UNICODE', 'NEWLINE_FIELD', 'MONEY_FORMATS', 'ZERO_INVOICE', 'TONU', 'WIDE_ROW', 'CREDIT_UNINVOICED',
];
const FORCED_ALL = ['UNKNOWN_STATUS', 'BAD_PRO_DERIVED', 'BAD_PRO_ALPHA', 'BAD_PRO_LONG', 'CHARGE_MISMATCH', 'LONG_ROW'];
const BASE_MIX = [['PAID', 80], ['UNPAID', 6], ['PARTIAL', 3], ['IVAN', 18], ['CREDIT', 2], ['DEBIT', 1], ['MULTI_STOP', 2], ['UNINVOICED_DELIVERED', 1]];

function weighted(rng, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of table) if ((r -= w) < 0) return k;
  return table[0][0];
}

export function generateAljex({ rows = 1000, seed = 1, anomalies = 'standard' } = {}) {
  if (!['none', 'standard', 'all'].includes(anomalies)) throw new Error(`anomalies must be none|standard|all, got ${anomalies}`);
  const rng = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const headers = ALJEX_HEADERS;
  const width = headers.length;
  const sc = scalarColumns(headers);
  const gr = groupColumns(headers);
  const K = sc.byKey;
  const withAnomalies = anomalies !== 'none';
  const all = anomalies === 'all';

  // ---- masters -------------------------------------------------------------------------------
  const nCust = Math.max(6, Math.floor(rows / 12));
  const customers = [];
  for (let i = 0; i < nCust; i++) {
    const [city, state, zip] = pick(CITIES);
    customers.push({
      account: `ZZA${pad(i + 1, 4)}`,
      names: [`ZZ ${pick(WORDS_A)} ${pick(WORDS_B)} ${pick(SUFFIX)} ${i + 1}`],
      street: `${int(100, 9999)} ${pick(STREETS)}`,
      city, state, zip,
      contact: i % 7 === 0 ? `${pick(FIRST)} ${pick(LAST)}` : '',
      leadSource: i % 3 === 0 ? 'ZZ Referral' : i % 3 === 1 ? 'ZZ Web Form' : '',
    });
  }
  if (withAnomalies && customers.length > 3) {
    const c = customers[2];
    c.names.push(`${c.names[0]} Holdings`, `${c.names[0].replace(/ \d+$/, '')} Intl`);
  }

  const nCar = Math.max(6, Math.floor(rows / 6));
  const carriers = [];
  for (let i = 0; i < nCar; i++) {
    carriers.push({
      id: `ZZK${pad(i + 1, 4)}`,
      name: `ZZ ${pick(WORDS_A)} ${pick(WORDS_B)} Freight ${i + 1}`,
      mc: String(100000 + i * 7 + int(0, 6)),
      mcPrefix: 'MC',
      dot: String(2000000 + i * 13 + int(0, 12)),
      scac: `Z${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}X`,
      safety: pick(['SATISFACTORY', 'SATISFACTORY', 'NONE', 'CONDITIONAL']),
      phone: `312555${pad(1000 + i, 4)}`,
      email: i % 3 === 0 ? `dispatch${i}@zz-carrier.example` : '',
      ...(i % 5 === 0 ? { caIntrastate: `ZZCA${pad(i + 1, 4)}`, caExp: '2027-03-15', txPuc: `ZZTX${pad(i + 1, 4)}`, txExp: '2027-09-30' } : {}),
    });
  }
  if (withAnomalies && carriers.length > 7) {
    carriers[4].name = carriers[3].name; // two ids, one name
    carriers[5].mc = ''; carriers[5].dot = ''; carriers[5].scac = ''; // no MC at all
    carriers[6].mcPrefix = 'MX';
    carriers[7].mc = `00${carriers[7].mc}`; // leading zeros kept
  }
  const ivan = { id: 'ZZIVAN', name: IVAN_NAME, mc: '999001', mcPrefix: 'MC', dot: '9990011', scac: 'ZIVN', safety: 'SATISFACTORY', phone: '3125550000', email: '' };

  // ---- row factory ---------------------------------------------------------------------------
  const recs = []; // { kind, cells, model }
  let proCounter = SYNTH_PRO_MIN + int(0, 20);
  const nextPro = () => {
    proCounter += int(1, 2);
    if (proCounter > SYNTH_PRO_MAX) throw new Error('fixture exhausted the reserved PRO band');
    return String(proCounter);
  };
  let checkCounter = 700000;
  const baseDay = dayNumber('2025-01-06');
  const spanDays = 640;

  const blank = () => new Array(width).fill('');
  const put = (cells, key, v) => {
    if (K[key] === undefined) throw new Error(`fixture: unknown column key ${key}`);
    cells[K[key]] = v == null ? '' : String(v);
  };

  function oddMoney(cents, style) {
    // Value-identical spellings of the same amount.
    const base = dollars(Math.abs(cents));
    const sign = cents < 0;
    if (style === 0) {
      const grouped = String(Math.floor(Math.abs(cents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return `${sign ? '-' : ''}$${grouped}.${pad(Math.abs(cents) % 100)}`;
    }
    if (style === 1) return sign ? `(${base})` : base;
    if (style === 2) return sign ? `${base}-` : base;
    return `${dollars(cents)}0`; // three decimals, zero remainder: exact
  }

  function buildLoad(scn, idx, allowAdj) {
    const model = { kind: 'LOAD', scenario: scn };
    const cells = blank();
    const isIvan = scn === 'IVAN';
    const isVoid = scn === 'VOID' || scn === 'VOID_WEB' || scn === 'BLANK_CUSTOMER_VOID';
    const blankCustomer = scn === 'BLANK_CUSTOMER_VOID';
    const cust = blankCustomer ? null : pick(customers);
    // the multi-name account is hit often enough that all three spellings appear
    const forcedName = scn === 'PAID' && idx % 5 === 0 && withAnomalies && customers.length > 3;
    const customer = forcedName ? customers[2] : cust;
    const custName = customer ? pick(customer.names) : '';
    const carrier = isIvan ? ivan : isVoid || blankCustomer ? null : pick(carriers);

    let pro = nextPro();
    if (scn === 'BAD_PRO_DERIVED') pro = 'S000123-1';
    if (scn === 'BAD_PRO_ALPHA') pro = `X${pro}`;
    if (scn === 'BAD_PRO_LONG') pro = `${pro}${pro}${pro}${pro}`;

    const ship = addDays('2025-01-06', Math.floor((idx * spanDays) / Math.max(rows, 1)));
    const status =
      { OPEN: 'OPEN', COVERED: 'COVERED', LOADED: 'LOADED', DISPATCHED: 'DISPATCHED', CONSIGNEE: 'CONSIGNEE', VOID: 'VOID', VOID_WEB: 'VOID WEB', BLANK_CUSTOMER_VOID: 'VOID' }[scn] ?? 'DELIVERED';
    const inFlight = ['OPEN', 'COVERED', 'LOADED', 'DISPATCHED', 'CONSIGNEE'].includes(status);
    const delivered = inFlight || isVoid ? '' : addDays(ship, int(1, 4));
    const created = addDays(ship, -2);
    const uninvoiced = inFlight || isVoid || scn === 'UNINVOICED_DELIVERED' || scn === 'CREDIT_UNINVOICED';
    const invoiceDate = uninvoiced ? '' : addDays(delivered, int(0, 3));

    // charges
    let lh = isVoid ? 0 : int(60000, 400000);
    if (scn === 'ZERO_INVOICE') lh = 0;
    if (isIvan) lh = int(30000, 150000);
    const lines = [{ code: 'F', desc: pick(COMMODITY), units: String(int(50, 1200)), weight: String(int(1000, 44000)), rate: lh, ext: lh }];
    let fsc = 0;
    if (!isVoid && lh > 0 && rng() < 0.3) {
      fsc = Math.round((lh * 0.1) / 100) * 100;
      lines[6] = { code: 'F', desc: pick(['FUEL SURCHARGE', 'FUEL CHARGE']), units: '', weight: '', rate: fsc, ext: fsc };
    }
    let slot = lines[6] ? 7 : 6; // 0-based index of the next free accessorial line (lines 7..14)
    const nAcc = isVoid || lh === 0 ? 0 : rng() < 0.35 ? int(1, 3) : 0;
    const accEntries = [];
    for (let a = 0; a < nAcc; a++) {
      const amount = pick([5000, 7500, 15000, 25000, 40000]) * (rng() < 0.08 ? -1 : 1);
      const desc = pick(ACC);
      lines[Math.min(slot++, 13)] = { code: 'F', desc, units: '', weight: '', rate: amount, ext: amount };
      accEntries.push({ desc, amount });
    }
    const forceOdd = scn === 'MONEY_FORMATS';
    if (scn === 'NEWLINE_FIELD' || scn === 'UNICODE' || (withAnomalies && idx % 9 === 4 && !isVoid && lh > 0 && lines[1] === undefined)) {
      lines[1] = { code: '', desc: 'Call ahead, "dock 4"\nbring straps', units: '', weight: '', rate: 0, ext: 0 };
    }
    if (forceOdd && lines[slot] === undefined) {
      lines[slot] = { code: 'F', desc: 'DETENTION', units: '', weight: '', rate: 123450, ext: 123450 };
      accEntries.push({ desc: 'DETENTION', amount: 123450 });
    }
    const sumExt = lines.reduce((s, l) => s + (l ? l.ext : 0), 0);
    const accTotal = sumExt - lh;
    let invoiceAmount = sumExt;
    if (scn === 'CHARGE_MISMATCH') invoiceAmount = sumExt + 100;
    model.lines = lines;

    // money: payments/credits/debits
    let payments = [];
    let credits = 0;
    let debits = 0;
    let bal = null;
    const invoiced = invoiceDate !== '' && invoiceAmount !== 0;
    if (allowAdj && scn === 'CREDIT') credits = Math.round(invoiceAmount * 0.08 / 100) * 100 || 500;
    if (allowAdj && scn === 'DEBIT') debits = 2500;
    if (allowAdj && scn === 'CREDIT_UNINVOICED') credits = 1500;
    if (invoiceDate !== '') {
      const owed = invoiceAmount - credits + debits;
      const payDate = addDays(invoiceDate, int(10, 45));
      const newCheck = () => String(checkCounter++);
      const pay = (amount, date) => payments.push({ n: payments.length + 1, amount, date, check: newCheck() });
      if (invoiced) {
        switch (scn) {
          case 'UNPAID': case 'UNINVOICED_DELIVERED': break;
          case 'PARTIAL': pay(Math.round(owed / 2 / 100) * 100, payDate); break;
          case 'OVERPAID': pay(owed + 2500, payDate); break;
          case 'TWO_PAYMENTS': { const first = Math.round(owed / 2 / 100) * 100; pay(first, payDate); pay(owed - first, addDays(payDate, 9)); break; }
          default: if (owed > 0) pay(owed, payDate);
        }
      }
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      bal = invoiceAmount - paid - credits + debits;
    }
    model.invoiced = invoiced;
    model.zeroInvoice = invoiceDate !== '' && invoiceAmount === 0;

    // carrier cost
    let projected = 0;
    let carrierLh = 0;
    let actual = 0;
    const proj = [];
    const paidExp = [];
    if (carrier && !isVoid) {
      carrierLh = isIvan ? 0 : Math.round((lh * 0.85) / 100) * 100;
      if (!isIvan && carrierLh > 0) {
        proj.push({ payee: carrier.name, type: 'LINE', amount: carrierLh });
        const extra = rng() < 0.3 ? int(1, scn === 'WIDE_ROW' ? 5 : 2) : scn === 'WIDE_ROW' ? 5 : 0;
        for (let e = 0; e < extra; e++) proj.push({ payee: '', type: pick(PROJ_TYPES), amount: pick([2500, 5000, 10000]) });
        projected = proj.reduce((s, p) => s + p.amount, 0);
        if (!inFlight && scn !== 'UNPAID') {
          const paidAll = proj.reduce((s, p) => s + p.amount, 0);
          const leave = idx % 17 === 3 ? Math.min(5000, paidAll) : 0; // some delivered loads stay unpaid at the carrier
          paidExp.push({ name: carrier.name, amount: paidAll - leave, date: addDays(delivered, int(2, 20)), check: String(500000 + idx), gl: '4400' });
          actual = paidAll - leave;
        }
      }
    }
    model.carrier = carrier ? { id: carrier.id, isIvan } : null;
    model.projected = projected;
    model.actual = actual;
    model.proj = proj;
    model.paidExp = paidExp;

    // ---- cells ----
    put(cells, 'office', 'ZZ');
    put(cells, 'proNo', pro);
    put(cells, 'customerId', customer ? customer.account : '');
    put(cells, 'customerName', custName);
    put(cells, 'customerAddress', customer ? customer.street : '');
    put(cells, 'customerCity', customer ? customer.city : '');
    put(cells, 'customerState', customer ? customer.state : '');
    put(cells, 'customerZip', customer ? customer.zip : '');
    put(cells, 'customerContact', customer ? customer.contact : '');
    const type = isVoid || blankCustomer ? '' : pick(TYPES);
    put(cells, 'typeOfShipment', type);
    put(cells, 'tonu', scn === 'TONU' ? 'Y' : 'N');
    const rep = pick(REPS);
    put(cells, 'salesrepId', isVoid ? '' : rep);
    const ref = `ZZREF${pro.slice(-5)}`;
    put(cells, 'referenceNo', isVoid ? '' : ref);
    put(cells, 'customerRefNo', isVoid ? '' : ref);
    let statusCell = status;
    if (scn === 'STATUS_LOWER') statusCell = 'delivered';
    if (scn === 'STATUS_TRAILING') statusCell = 'DELIVERED ';
    if (scn === 'UNKNOWN_STATUS') statusCell = 'ZZ-ODD-STATUS';
    put(cells, 'dispatchStatus', statusCell);
    model.statusKey = status;
    model.statusCell = statusCell;

    let shipCell = us(ship);
    if (scn === 'JUNK_70') shipCell = '01/01/70';
    if (scn === 'JUNK_20') shipCell = '01/01/20';
    if (scn === 'JUNK_23') shipCell = '03/05/23';
    if (scn === 'JUNK_BLANK') shipCell = '';
    let deliveredCell = us(delivered);
    if (scn === 'SHIP_AFTER_DELIVERED') deliveredCell = us(addDays(ship, -3));
    put(cells, 'invoiceDate', us(invoiceDate));
    put(cells, 'shipDate', isVoid ? '' : shipCell);
    put(cells, 'deliveryApptDate', delivered ? us(delivered) : '');
    put(cells, 'deliveryApptTime', delivered && idx % 3 === 0 ? '09:30' : '');
    put(cells, 'deliveredDate', deliveredCell);
    put(cells, 'createdDate', us(created));
    put(cells, 'createdTime', '08:15');
    put(cells, 'coveredDate', carrier ? us(addDays(ship, -1)) : '');
    put(cells, 'releaseDate', invoiceDate ? us(invoiceDate) : '');
    const enteredBy = pick(STAFF);
    const createdBy = pick(STAFF);
    const actualDispatcher = carrier ? pick(STAFF) : '';
    const assignedDispatcher = carrier && idx % 2 === 0 ? pick(STAFF) : '';
    const serviceRep = !isVoid && idx % 5 === 0 ? pick(STAFF) : '';
    put(cells, 'enteredBy', enteredBy);
    put(cells, 'createdBy', createdBy);
    put(cells, 'actualDispatcher', actualDispatcher);
    put(cells, 'assignedDispatcher', assignedDispatcher);
    put(cells, 'serviceRep', serviceRep);
    put(cells, 'leadSource', customer ? customer.leadSource : '');
    model.codes = { salesRep: isVoid ? '' : /^\d+$/.test(rep) ? rep.padStart(3, '0') : rep, createdBy, serviceRep, assignedDispatcher, actualDispatcher };
    put(cells, 'mode', isVoid || blankCustomer ? '' : 'BROKERAGE');
    put(cells, 'revenueType', isIvan ? 'I' : 'B');
    model.scenarioDates = { ship, delivered, invoiceDate, created, junkShip: ['JUNK_70', 'JUNK_20', 'JUNK_23', 'JUNK_BLANK'].includes(scn) };

    // billing party
    if (customer) {
      put(cells, 'billToId', customer.account);
      put(cells, 'billToName', custName);
      put(cells, 'billToAddress', customer.street);
      put(cells, 'billToCity', customer.city);
      put(cells, 'billToState', customer.state);
      put(cells, 'billToZip', customer.zip);
    }

    // stops
    if (!isVoid && !blankCustomer) {
      const [oc, os, oz] = pick(CITIES);
      const [dc, ds, dz] = pick(CITIES);
      put(cells, 'pickupName', `ZZ ${pick(WORDS_A)} Warehouse`);
      put(cells, 'pickupCity', oc); put(cells, 'pickupState', os); put(cells, 'pickupZip', oz);
      put(cells, 'pickUpAddress', `${int(100, 9999)} ${pick(STREETS)}`);
      put(cells, 'pickupRefNo', idx % 2 === 0 ? `PU${pro.slice(-4)}` : '');
      put(cells, 'consigneeName', `ZZ ${pick(WORDS_B)} Receiving`);
      put(cells, 'consigneeCity', dc); put(cells, 'consigneeState', ds); put(cells, 'consigneeZip', dz);
      put(cells, 'finalConsigneeAddress', `${int(100, 9999)} ${pick(STREETS)}`);
      model.stopBlocks = 0;
      if (scn === 'MULTI_STOP') {
        const nBlocks = int(1, 3);
        model.stopBlocks = nBlocks;
        for (let b = 0; b < nBlocks; b++) {
          const f = gr.stops[b].fields;
          const [bc, bs, bz] = pick(CITIES);
          cells[f.marker] = b === 0 ? 'S' : pick(['P', 'S']);
          cells[f.name] = `ZZ Stop ${b + 1} ${pick(WORDS_A)}`;
          cells[f.address] = `${int(100, 9999)} ${pick(STREETS)}`;
          cells[f.city] = bc; cells[f.state] = bs; cells[f.zip] = bz;
          cells[f.phone] = '3125550199';
        }
      }
    } else if (blankCustomer) {
      // memo-like consignee-less void with no carrier
    }

    // freight
    put(cells, 'commodity', lines[0].desc);
    put(cells, 'weight', lines[0].weight);
    put(cells, 'miles', lines[0].units);
    put(cells, 'hot', scn === 'MULTI_STOP' ? 'Y' : '');

    // money summary
    put(cells, 'lhRevenue', dollars(lh));
    put(cells, 'accRevenue', dollars(accTotal));
    put(cells, 'fscRevenue', dollars(fsc));
    put(cells, 'invoiceAmount', dollars(invoiceAmount));
    put(cells, 'paymentsReceived', dollars(payments.reduce((s, p) => s + p.amount, 0)));
    put(cells, 'credits', credits ? dollars(credits) : '0.00');
    put(cells, 'debits', debits ? dollars(debits) : '0.00');
    put(cells, 'balDue', bal == null ? '' : dollars(bal));
    put(cells, 'projectedCarrierExpense', dollars(projected));
    put(cells, 'carrierLh', dollars(carrierLh));
    put(cells, 'carrierAccessorial', dollars(projected - carrierLh));
    put(cells, 'actualCarrierExp', dollars(actual));
    put(cells, 'quickPayFees', '0.00');
    put(cells, 'advanceFees', '0.00');

    // charge lines
    lines.forEach((l, i) => {
      if (!l) return;
      const f = gr.charges[i].fields;
      cells[f.code] = l.code;
      cells[f.description] = l.desc;
      cells[f.units] = l.units;
      cells[f.weight] = l.weight;
      cells[f.rate] = l.ext || l.rate ? dollars(l.rate) : '';
      cells[f.extension] = l.ext || l.code ? dollars(l.ext) : '';
    });
    if (forceOdd) {
      // swap value-identical spellings into the cells of the line haul and the accessorial
      const ext1 = gr.charges[0].fields.extension;
      cells[ext1] = oddMoney(lines[0].ext, 0);
      const idx7 = lines.findIndex((l, i) => i >= 6 && l);
      if (idx7 >= 0) cells[gr.charges[idx7].fields.extension] = oddMoney(lines[idx7].ext, 3);
    }
    if (scn === 'MONEY_FORMATS' || (withAnomalies && idx % 11 === 6 && lh > 0)) {
      // negative accessorial spelled `20.00-`, plus a three-decimal cell that rounds (flagged, value used = rounded)
      const slotIdx = lines.findIndex((l, i) => i >= 6 && l && l.ext < 0);
      if (slotIdx >= 0) cells[gr.charges[slotIdx].fields.extension] = oddMoney(lines[slotIdx].ext, 2);
    }
    // accessorial mirror pairs (partial mirror of the non-fuel lines)
    accEntries.slice(0, 4).forEach((a, i) => {
      cells[gr.accessorials[i].fields.charge] = a.desc;
      cells[gr.accessorials[i].fields.label] = dollars(a.amount);
    });
    // nb: orientation of the pair (label vs amount column) is unconfirmed; the mapper accepts either.

    // customer payments
    payments.forEach((p, i) => {
      const f = gr.customerPayments[i].fields;
      cells[f.date] = us(p.date);
      cells[f.amount] = dollars(p.amount);
      cells[f.daysToPay] = String(dayNumber(p.date) - dayNumber(invoiceDate));
      if (f.checkNo !== undefined) cells[f.checkNo] = p.check;
    });
    // projected expenses
    proj.forEach((p, i) => {
      const f = gr.projectedExpenses[i].fields;
      cells[f.expense] = p.payee;
      cells[f.amount] = dollars(p.amount);
      cells[f.type] = p.type;
    });
    // carrier block
    if (carrier) {
      put(cells, 'carrierId', carrier.id);
      put(cells, 'carrierName', carrier.name);
      put(cells, 'carrierMcPrefix', carrier.mc ? carrier.mcPrefix : '');
      put(cells, 'carrierMc', carrier.mc);
      put(cells, 'carrierDot', carrier.dot);
      put(cells, 'carrierScac', carrier.scac);
      put(cells, 'carrierSafetyRating', carrier.safety);
      put(cells, 'carrierPhone', carrier.phone);
      put(cells, 'carrierEmail', carrier.email);
      put(cells, 'carrierDispatcher', `${pick(FIRST)} ${pick(LAST)}`);
      if (!isIvan && idx % 4 === 0) {
        // Real Aljex: `Carrier Ref #` repeats Driver Name, which is a bare first name shared by many loads.
        const driverFirst = pick(FIRST);
        pick(LAST);
        put(cells, 'driverName', driverFirst);
        put(cells, 'carrierRefNo', driverFirst);
      }
      put(cells, 'carrierCaIntrastate', carrier.caIntrastate ?? '');
      put(cells, 'carrierCaIntrastateExp', us(carrier.caExp ?? ''));
      put(cells, 'carrierTxPuc', carrier.txPuc ?? '');
      put(cells, 'carrierTxPucExp', us(carrier.txExp ?? ''));
    }
    paidExp.forEach((p, i) => {
      const f = gr.paidExpenses[i].fields;
      cells[f.name] = p.name;
      cells[f.amount] = dollars(p.amount);
      cells[f.date] = us(p.date);
      cells[f.checkNo] = p.check;
      cells[f.gl] = p.gl;
    });
    if (rep) {
      const f = gr.commissions[0].fields;
      cells[f.rep] = isVoid ? '' : rep;
      cells[f.amt] = isVoid ? '' : '0.00';
    }
    // ---- promoted columns (DECIDED-3): synthetic values on every 4th live load ----------------------
    const rich = !isVoid && !blankCustomer && idx % 4 === 0;
    const quickPay = rich && carrier && !isIvan && carrierLh > 0 && idx % 8 === 0 ? -1500 : 0;
    const advance = rich && carrier && !isIvan && carrierLh > 0 && idx % 8 === 4 ? 2000 : 0;
    put(cells, 'quickPayFees', quickPay ? dollars(quickPay) : '0.00');
    put(cells, 'advanceFees', advance ? dollars(advance) : '0.00');
    put(cells, 'currency', scn === 'JUNK_20' ? 'CAD' : rich ? 'USD' : '');
    model.currency = scn === 'JUNK_20' ? 'CAD' : rich ? 'USD' : '';
    model.fees = { quickPayCents: quickPay, advanceCents: advance };
    model.promoted = null;
    if (rich) {
      const sfx = pro.slice(-4);
      const p = {
        quoteNo: `ZZQ${sfx}`, manifest: `ZZMAN${sfx}`, container: `ZZCONT${sfx}`, additionalRefs: [`ZZADD${sfx}A`, `ZZADD${sfx}B`],
        consigneeRef: `ZZCR${sfx}`, osd: true, pltIn: 3, pltOut: 2, seal: 'Y', declaredValueCents: 5000000, flags: PROMOTED_FLAGS,
      };
      put(cells, 'quoteNo', p.quoteNo);
      put(cells, 'manifest', p.manifest);
      put(cells, 'containerNo', p.container);
      p.additionalRefs.forEach((v, i) => { cells[gr.additionalRefs[i].fields.ref] = v; });
      put(cells, 'consigneeRefNo', p.consigneeRef);
      put(cells, 'osd', 'Y');
      put(cells, 'pltIn', p.pltIn);
      put(cells, 'pltOut', p.pltOut);
      put(cells, 'seal', p.seal);
      put(cells, 'declaredValue', dollars(p.declaredValueCents));
      for (const k of PROMOTED_FLAGS) put(cells, k, 'Y');
      put(cells, 'officeCoveredBy', 'ZZ');
      put(cells, 'originRegion', 'WC');
      put(cells, 'destinationRegion', 'NE');
      model.promoted = p;
    }
    if (scn === 'UNICODE') {
      cells[K.customerName] = `ZZ Caf\u00e9 Ni\u00f1o \u5317\u4eac\u7269\u6d41 \ud83d\ude9a\u00a0Co \u201cQuoted\u201d`;
      cells[K.billToName] = cells[K.customerName];
      model.unicodeName = cells[K.customerName];
    }
    if (scn === 'NEWLINE_FIELD') cells[K.commodity] = 'PALLETS, "FRAGILE"\nHANDLE WITH CARE';

    // right-truncate like the export: 474 fields normally, wider when proj exp 6..9 exist
    const w = proj.length >= 6 ? Math.min(486, 474 + 3 * (proj.length - 5)) : 474;
    model.pro = pro;
    model.customer = customer ? customer.account : '';
    model.customerNameCell = custName;
    model.lh = lh;
    model.acc = accTotal;
    model.fsc = fsc;
    model.invoiceAmount = invoiceAmount;
    model.payments = payments;
    model.credits = credits;
    model.debits = debits;
    model.bal = bal;
    model.ship = ship;
    model.mismatch = scn === 'CHARGE_MISMATCH';
    // rows the importer must refuse/skip are tracked apart so the totals stay what a clean apply produces
    if (['BAD_PRO_DERIVED', 'BAD_PRO_ALPHA', 'BAD_PRO_LONG', 'LONG_ROW', 'UNKNOWN_STATUS'].includes(scn)) model.kind = 'REJECTED';
    return { cells: scn === 'LONG_ROW' ? [...cells, 'ZZ-EXTRA'] : cells.slice(0, w), model, width: w };
  }

  function buildMemo(kind, load, amountCents, idx, opts = {}) {
    const cells = blank();
    const pro = nextPro();
    const signed = kind === 'CRED' ? -amountCents : amountCents;
    const customer = customers.find((c) => c.account === load.model.customer) ?? customers[0];
    const d = load.model.scenarioDates.invoiceDate || load.model.scenarioDates.created;
    const referencePro = opts.orphan === 'NO_REFERENCE' ? '' : load.model.pro;
    put(cells, 'office', 'ZZ');
    put(cells, 'proNo', pro);
    put(cells, 'customerId', customer.account);
    put(cells, 'customerName', customer.names[0]);
    put(cells, 'customerAddress', customer.street);
    put(cells, 'customerCity', customer.city);
    put(cells, 'customerState', customer.state);
    put(cells, 'customerZip', customer.zip);
    put(cells, 'typeOfShipment', kind);
    put(cells, 'referenceNo', referencePro);
    put(cells, 'postedInfo', `ZZ posted ${kind} ${pro}`);
    put(cells, 'invoiceDate', us(d));
    put(cells, 'shipDate', us(d));
    put(cells, 'createdDate', us(d));
    put(cells, 'consigneeCity', customer.city);
    put(cells, 'billToId', customer.account);
    put(cells, 'billToName', customer.names[0]);
    for (const k of ['lhRevenue', 'invoiceAmount']) put(cells, k, dollars(signed));
    for (const k of ['accRevenue', 'fscRevenue', 'paymentsReceived', 'credits', 'debits', 'balDue', 'projectedCarrierExpense', 'carrierLh', 'carrierAccessorial', 'actualCarrierExp']) put(cells, k, '0.00');
    const f = gr.charges[0].fields;
    cells[f.code] = '2';
    cells[f.description] = `ZZ ${kind} memo`;
    cells[f.rate] = dollars(signed);
    cells[f.extension] = dollars(signed);
    void idx;
    // linked to an invoice unless the reference is missing/unknown or names a load that is not invoiced
    const orphanReason = opts.orphan ?? (load.model.invoiced ? null : 'REFERENCE_NOT_INVOICED');
    return { cells: cells.slice(0, 473), model: { kind: kind === 'CRED' ? 'MEMO_CRED' : 'MEMO_DEBT', pro, amount: signed, customer: customer.account, referencePro, orphanReason } };
  }

  // ---- generate -------------------------------------------------------------------------------
  const nIdentical = withAnomalies ? Math.min(rows >= 100 ? 4 : 2, Math.floor(rows / 10)) : 0;
  const nConflict = withAnomalies && rows >= 20 ? 1 : 0;
  const nOrphanMemo = withAnomalies && rows >= 20 ? 2 : 0;
  const target = rows - nIdentical - nConflict - nOrphanMemo;
  const forced = withAnomalies ? [...FORCED_STANDARD, ...(all ? FORCED_ALL : [])] : [];
  let loadIdx = 0;
  const lines = [];
  while (lines.length < target) {
    const scn = loadIdx < forced.length ? forced[loadIdx] : weighted(rng, BASE_MIX);
    const adj = ['CREDIT', 'DEBIT', 'CREDIT_UNINVOICED'].includes(scn);
    const need = 1 + (adj ? 1 : 0);
    const allowAdj = lines.length + need <= target;
    const s = allowAdj || !adj ? scn : 'PAID';
    const load = buildLoad(s, loadIdx, allowAdj);
    loadIdx++;
    lines.push(load);
    if (allowAdj && load.model.credits) lines.push(buildMemo('CRED', load, load.model.credits, loadIdx));
    if (allowAdj && load.model.debits) lines.push(buildMemo('DEBT', load, load.model.debits, loadIdx));
  }
  // anomalies that duplicate existing rows
  const loadsOnly = lines.filter((l) => l.model.kind === 'LOAD' && l.model.scenario === 'PAID');
  const dupSources = [];
  for (let i = 0; i < nIdentical; i++) {
    const src = loadsOnly[i * 3 % Math.max(loadsOnly.length, 1)] ?? lines.find((l) => l.model.kind === 'LOAD');
    dupSources.push(src);
    lines.push({ cells: [...src.cells], model: { ...src.model, duplicateOf: src.model.pro, kind: 'DUP_IDENTICAL' }, width: src.width });
  }
  if (nConflict) {
    const src = loadsOnly[loadsOnly.length - 1] ?? lines.find((l) => l.model.kind === 'LOAD');
    const cells = [...src.cells];
    cells[K.customerName] = `${cells[K.customerName]} CONFLICT`;
    cells[K.invoiceAmount] = dollars(src.model.invoiceAmount + 100);
    lines.push({ cells, model: { ...src.model, invoiceAmount: src.model.invoiceAmount + 100, duplicateOf: src.model.pro, kind: 'DUP_CONFLICT' }, width: src.width });
  }
  // memos DECIDED-1 reports but cannot apply: a Reference # that is no load in the file, and a blank one
  if (nOrphanMemo) {
    const ghost = { model: { customer: customers[0].account, scenarioDates: { invoiceDate: '2025-03-03', created: '2025-03-01' }, pro: '999999', invoiced: false } };
    lines.push(buildMemo('CRED', ghost, 4200, 0, { orphan: 'REFERENCE_NOT_FOUND' }));
    lines.push(buildMemo('DEBT', ghost, 1700, 0, { orphan: 'NO_REFERENCE' }));
  }

  const outRows = lines.map((l) => l.cells);

  // ---- oracle (from the model, never from the importer) ----------------------------------------
  const models = lines.map((l) => l.model);
  const uniq = models.filter((m) => m.kind === 'LOAD' || m.kind === 'MEMO_DEBT' || m.kind === 'MEMO_CRED');
  const loadsU = uniq.filter((m) => m.kind === 'LOAD');
  const memos = uniq.filter((m) => m.kind !== 'LOAD');
  const sum = (arr, f) => arr.reduce((s, m) => s + f(m), 0);
  const sumFile = (arr, f) => arr.reduce((s, m) => s + f(m), 0);
  const invoicedLoads = loadsU.filter((m) => m.invoiced);
  const openInvoices = invoicedLoads.filter((m) => m.bal > 0);
  const perCustomerOpen = {};
  for (const m of openInvoices) perCustomerOpen[m.customer] = (perCustomerOpen[m.customer] ?? 0) + m.bal;
  const statusCounts = {};
  for (const m of loadsU) statusCounts[m.statusKey] = (statusCounts[m.statusKey] ?? 0) + 1;
  const apBills = loadsU.filter((m) => m.carrier && !m.carrier.isIvan && m.statusKey === 'DELIVERED' && m.projected > 0);
  const perCarrierOpenAp = {};
  for (const m of apBills) {
    const open = m.projected - m.actual;
    if (open > 0) perCarrierOpenAp[m.carrier.id] = (perCarrierOpenAp[m.carrier.id] ?? 0) + open;
  }
  const dupRows = models.filter((m) => m.kind === 'DUP_IDENTICAL' || m.kind === 'DUP_CONFLICT');
  const fileLoads = models.filter((m) => m.kind === 'LOAD' || m.kind === 'DUP_IDENTICAL' || m.kind === 'DUP_CONFLICT');
  const scenarioPros = (s) => loadsU.filter((m) => m.scenario === s).map((m) => m.pro);
  const totals = (arr, memosArr) => ({
    lhRevenue: sum(arr, (m) => m.lh) + sum(memosArr, (m) => m.amount),
    accRevenue: sum(arr, (m) => m.acc),
    fscRevenue: sum(arr, (m) => m.fsc),
    invoiceAmount: sum(arr, (m) => m.invoiceAmount) + sum(memosArr, (m) => m.amount),
    invoiceAmountLoads: sum(arr, (m) => m.invoiceAmount),
    payments: sum(arr, (m) => sum(m.payments, (p) => p.amount)),
    credits: sum(arr, (m) => m.credits),
    debits: sum(arr, (m) => m.debits),
    balDue: sum(arr, (m) => m.bal ?? 0),
  });
  const orphanMemos = memos.filter((m) => m.orphanReason);
  const linkedMemos = memos.filter((m) => m.orphanReason !== 'NO_REFERENCE' && m.orphanReason !== 'REFERENCE_NOT_FOUND');
  const adjByInvoice = {};
  for (const m of memos) if (!m.orphanReason) adjByInvoice[m.referencePro] = (adjByInvoice[m.referencePro] ?? 0) + m.amount;
  const codesOf = (k) => Object.fromEntries(loadsU.filter((m) => m.codes?.[k]).map((m) => [m.pro, m.codes[k]]));
  const carrierById = Object.fromEntries(carriers.map((c) => [c.id, c]));
  const usedCarrierIds = new Set(loadsU.filter((m) => m.carrier && !m.carrier.isIvan).map((m) => m.carrier.id));
  const usedCustomerAccounts = new Set(loadsU.filter((m) => m.customer).map((m) => m.customer));
  const oracle = {
    seed,
    anomalies,
    synthetic: true,
    layoutId: 'aljex-full-486-v1',
    headerCount: width,
    // rows as they appear in the file (duplicates included)
    fileRows: lines.length,
    // unique PROs by kind (first occurrence wins; identical duplicates collapse; a conflicting duplicate is skipped)
    loads: loadsU.length,
    memos: memos.length,
    memoDebt: memos.filter((m) => m.kind === 'MEMO_DEBT').length,
    memoCred: memos.filter((m) => m.kind === 'MEMO_CRED').length,
    identicalDuplicateRows: models.filter((m) => m.kind === 'DUP_IDENTICAL').length,
    conflictingDuplicateRows: models.filter((m) => m.kind === 'DUP_CONFLICT').length,
    statusCounts,
    uniqueTotals: totals(loadsU, memos),
    fileTotals: totals(fileLoads, memos),
    invoices: invoicedLoads.length,
    zeroInvoiceLoads: loadsU.filter((m) => m.zeroInvoice).length,
    uninvoicedLoadsWithAmount: loadsU.filter((m) => !m.invoiced && m.invoiceAmount > 0).length,
    uninvoicedAmount: sum(loadsU.filter((m) => !m.invoiced), (m) => m.invoiceAmount),
    // credits/debits carried by loads that have no invoice: outside the AR bridge (the memo still exists)
    creditsOnUninvoiced: sum(loadsU.filter((m) => !m.invoiced), (m) => m.credits),
    debitsOnUninvoiced: sum(loadsU.filter((m) => !m.invoiced), (m) => m.debits),
    openAr: { count: openInvoices.length, balance: sum(openInvoices, (m) => m.bal) },
    unappliedCredit: sum(invoicedLoads.filter((m) => m.bal < 0), (m) => -m.bal),
    perCustomerOpen,
    // Bridge: net open AR in BCAT = open invoices - unapplied credit = Σ Bal Due over invoiced loads
    netOpenAr: sum(invoicedLoads, (m) => m.bal),
    memoNet: sum(memos, (m) => m.amount),
    // memo cross-check: Σ CRED = -Σ load credits, Σ DEBT = Σ load debits
    memoCredTotal: sum(memos.filter((m) => m.kind === 'MEMO_CRED'), (m) => m.amount),
    memoDebtTotal: sum(memos.filter((m) => m.kind === 'MEMO_DEBT'), (m) => m.amount),
    // derived AP (delivered, non-own-asset, projected > 0): balance = projected - paid
    ap: { bills: apBills.length, open: Object.values(perCarrierOpenAp).reduce((a, b) => a + b, 0), perCarrierOpen: perCarrierOpenAp },
    customers: new Set(uniq.filter((m) => m.customer).map((m) => m.customer)).size,
    carriers: new Set(loadsU.filter((m) => m.carrier).map((m) => m.carrier.id)).size,
    ivanLoads: loadsU.filter((m) => m.carrier?.isIvan).length,
    anomalyPros: {
      identicalDuplicates: models.filter((m) => m.kind === 'DUP_IDENTICAL').map((m) => m.pro),
      conflictingDuplicates: models.filter((m) => m.kind === 'DUP_CONFLICT').map((m) => m.pro),
      junkShipDates: loadsU.filter((m) => m.scenarioDates.junkShip).map((m) => m.pro),
      shipAfterDelivered: scenarioPros('SHIP_AFTER_DELIVERED'),
      blankCustomer: scenarioPros('BLANK_CUSTOMER_VOID'),
      unknownStatus: models.filter((m) => m.scenario === 'UNKNOWN_STATUS').map((m) => m.pro),
      badPros: models.filter((m) => ['BAD_PRO_DERIVED', 'BAD_PRO_ALPHA', 'BAD_PRO_LONG'].includes(m.scenario)).map((m) => m.pro),
      rejected: models.filter((m) => m.kind === 'REJECTED').map((m) => m.pro),
      chargeMismatch: loadsU.filter((m) => m.mismatch).map((m) => m.pro),
      overpaid: loadsU.filter((m) => m.invoiced && m.bal < 0).map((m) => m.pro),
      zeroInvoice: loadsU.filter((m) => m.zeroInvoice).map((m) => m.pro),
      wideRows: loadsU.filter((m) => m.scenario === 'WIDE_ROW').map((m) => m.pro),
      longRows: models.filter((m) => m.scenario === 'LONG_ROW').map((m) => m.pro),
    },
    scenarios: Object.fromEntries([...new Set(loadsU.map((m) => m.scenario))].map((s) => [s, scenarioPros(s)])),
    // ---- DECIDED-1: memos are adjustment lines on the referenced invoice -------------------------
    memoAdjustments: {
      applied: memos.length - orphanMemos.length,
      appliedNet: sum(memos.filter((m) => !m.orphanReason), (m) => m.amount),
      // net signed adjustment per invoice PRO (CRED negative, DEBT positive)
      byInvoice: adjByInvoice,
      orphans: orphanMemos.map((m) => ({ memoPro: m.pro, kind: m.kind === 'MEMO_DEBT' ? 'DEBT' : 'CRED', referencePro: m.referencePro, signedAmountCents: m.amount, reason: m.orphanReason })),
      orphanNet: sum(orphanMemos, (m) => m.amount),
    },
    // memos whose Reference # is a load in the file (the ones the load-level Credits/Debits columns echo)
    memoLinkedCredTotal: sum(linkedMemos.filter((m) => m.kind === 'MEMO_CRED'), (m) => m.amount),
    memoLinkedDebtTotal: sum(linkedMemos.filter((m) => m.kind === 'MEMO_DEBT'), (m) => m.amount),
    // invoice total = Invoice Amount + net memo adjustments; balance = total - payments = Bal Due
    invoiceTotalWithMemos: sum(invoicedLoads, (m) => m.invoiceAmount + (adjByInvoice[m.pro] ?? 0)),
    invoicePayments: sum(invoicedLoads, (m) => sum(m.payments, (p) => p.amount)),
    // ---- DECIDED-4: Aljex codes stored verbatim ('10' -> '010'), by PRO ----------------------------
    codes: {
      salesRep: codesOf('salesRep'),
      createdBy: codesOf('createdBy'),
      serviceRep: codesOf('serviceRep'),
      dispatcher: codesOf('assignedDispatcher'),
      actualDispatcher: codesOf('actualDispatcher'),
    },
    salesRepCodeCounts: Object.values(codesOf('salesRep')).reduce((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {}),
    // ---- DECIDED-3: promoted columns --------------------------------------------------------------
    promoted: Object.fromEntries(loadsU.filter((m) => m.promoted).map((m) => [m.pro, m.promoted])),
    fees: {
      quickPayCents: sum(loadsU, (m) => m.fees.quickPayCents),
      advanceCents: sum(loadsU, (m) => m.fees.advanceCents),
      byPro: Object.fromEntries(loadsU.filter((m) => m.fees.quickPayCents || m.fees.advanceCents).map((m) => [m.pro, m.fees])),
    },
    carrierCompliance: Object.fromEntries(
      [...usedCarrierIds].map((id) => [id, carrierById[id]]).filter(([, c]) => c?.caIntrastate).map(([id, c]) => [id, { caIntrastate: c.caIntrastate, caIntrastateExp: c.caExp, txPuc: c.txPuc, txPucExp: c.txExp }]),
    ),
    customerLeadSource: Object.fromEntries(customers.filter((c) => c.leadSource && usedCustomerAccounts.has(c.account)).map((c) => [c.account, c.leadSource])),
    nonUsdCurrencyPros: loadsU.filter((m) => m.currency && m.currency !== 'USD').map((m) => m.pro),
    dupCount: dupRows.length,
  };

  return { headers, rows: outRows, oracle };
}

/** Render rows as the export looks: every field double-quoted. */
export function renderAljexCsv(result, { bom = false, crlf = false, delimiter = ',' } = {}) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const eol = crlf ? '\r\n' : '\n';
  const body = [result.headers, ...result.rows].map((r) => r.map(q).join(delimiter)).join(eol) + eol;
  return (bom ? '\ufeff' : '') + body;
}
