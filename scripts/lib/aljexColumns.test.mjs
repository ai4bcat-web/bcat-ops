import { describe, expect, it } from 'vitest';
import {
  GROUP_COUNTS,
  groupColumns,
  normalizeHeader,
  scalarColumns,
} from './aljexColumns.mjs';

// Synthetic header row: the 486 column NAMES of the Aljex full export (schema only,
// no row values). Duplicated names are intentional - that is the real layout.
const HEADERS = [
  "Office", "Pro #", "Master Invoice", "Customer Account #", "Customer Name", "Customer Address",
  "Customer City", "Customer State", "Customer Zip", "Type of Shipment", "TONU", "Salesrep ID",
  "Reference #", "Dispatch Status", "Invoice Date", "Ship Date", "ETA Date", "Delivery Appt Date",
  "Delivery Appt Time", "Deliver Appt Note", "Must Deliver Date", "Delivered Date", "Future Use",
  "Posted Info", "Bill To Account", "Bill To Name", "Bill To Address", "Bill To City", "Bill To State",
  "Bill To Zip", "Pickup Name", "Pickup City", "Pickup State", "Pickup Zip", "Consignee Name",
  "Consignee City", "Consignee State", "Consignee Zip", "Line Haul Carrier ID", "Carrier Name",
  "Carrier Ref #", "Carrier Dispatcher", "Description", "Weight", "Footage", "Manifest", "Customer Ref #",
  "Container #", "Miles/Class", "Entered", "Covered", "Revenue Type", "LH Revenue", "Acc Revenue",
  "Projected Carrier Expense", "Carrier LH", "Carrier Accessorial", "Projected Gross Profit", "Projected Profit %",
  "Payments Received", "Actual Carrier Exp", "Accessorial Profit", "Credits", "Debits", "Bal Due",
  "Projected L/H Profit", "Advance Fees", "Quick Pay Fees", "OSD (Y/N)", "Commission Rep 1", "Commission Amt 1",
  "Commission Created From 1", "Commission GNF 1", "Commission % 1", "Commis Flat $ 1", "Posted Commis 1",
  "Commission Rep 2", "Commission Amt 2", "Commission ISP 2", "Commis GNF 2", "Commis % 2", "Commission Flat $ 2",
  "Posted Commission 2", "Commission Rep 3", "Commission Amt 3", "Commission ISP 3", "Commission GNF 3",
  "Commission % 3", "Commission Flat $ 3", "Posted Commission 3", "Paid Date 1", "Paid Amount 1",
  "Days to Pay 1", "Paid Ck# 1", "Paid Date 2", "Paid Amount 2", "Days to Pay 2", "Paid Ck# 2",
  "Paid Date 3", "Paid Amount 3", "Days to Pay 3", "Proj Exp 1", "Proj Amt 1", "Type 1", "Proj Exp 2",
  "Proj Amt 2", "Type 2", "Proj Exp 3", "Proj Amt 3", "Type 3", "Proj Exp 4", "Proj Amt 4", "Type 4",
  "Proj Exp 5", "Proj Amt 5", "Type 5", "Mode", "Release Date", "Release Time", "Release By", "Billed by",
  "FSC Revenue", "Invoice Amount", "Acc Charge 1", "Acc 1", "Acc Charge 2", "Acc 2", "Acc Charge 3",
  "Acc 3", "Acc Charge 4", "Acc 4", "Benchmark", "Lead Source", "Quote #", "Paid Exp Name", "Paid Exp Amt",
  "Paid Exp Date", "Paid Exp Ck#", "Paid Exp GL", "Paid Exp Name", "Paid Exp Amt", "Paid Exp Date",
  "Paid Exp Ck#", "Paid Exp GL", "Paid Exp Name", "Paid Exp Amt", "Paid Exp Date", "Paid Exp Ck#",
  "Paid Exp GL", "Paid Exp Name", "Paid Exp Amt", "Paid Exp Date", "Paid Exp Ck#", "Paid Exp GL",
  "Paid Exp Name", "Paid Exp Amt", "Paid Exp Date", "Paid Exp Ck#", "Paid Exp GL", "Paid Exp Name",
  "Paid Exp Amt", "Paid Exp Date", "Paid Exp Ck#", "Paid Exp GL", "Paid Exp Name", "Paid Exp Amt",
  "Paid Exp Date", "Paid Exp Ck#", "Paid Exp GL", "Paid Exp Name", "Paid Exp Amt", "Paid Exp Date",
  "Paid Exp Ck#", "Paid Exp GL", "Origin Region", "Destination Region", "Hazmat", "Temp Control",
  "Seal", "Plt Exchange", "Plt In", "Plt Out", "Blind", "Customs Bond", "Declared Value", "Escort",
  "High Risk", "Hot", "Labor", "Over Size", "Permit", "Tarps", "Tarp Size", "Team", "ps1", "Name",
  "Address", "City", "State", "Zip", "Phone", "Ref #", "PS2", "Name", "Address", "City", "State",
  "Zip", "Phone", "Ref #", "PS3", "Name", "Address", "City", "State", "Zip", "Phone", "ref", "PS4",
  "Name", "Address", "City", "State", "Zip", "Phone", "Ref #", "PS5", "Name", "Address", "City",
  "State", "Zip", "Phone", "Ref #", "PS6", "Name", "Address", "City", "State", "Zip", "Phone",
  "Ref #", "PS", "Name", "Address", "City", "State", "Zip", "Phone", "Ref #", "PS8", "Name", "Address",
  "City", "State", "Zip", "Phone", "Ref #", "PS9", "Name", "Address", "City", "State", "Zip", "Phone",
  "Ref #", "PS10", "Name", "Address", "City", "State", "Zip", "Phone", "Ref #", "PS11", "Name",
  "Address", "City", "State", "Zip", "Phone", "Ref #", "PS12", "Name", "Address", "City", "State",
  "Zip", "Phone", "Ref #", "Code", "Description", "Miles/Units/Code/Class", "Weight", "Rate", "Extension",
  "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description",
  "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class",
  "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension",
  "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description",
  "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class",
  "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension",
  "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description",
  "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class",
  "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension",
  "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description",
  "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class",
  "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension",
  "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description",
  "Units/Code/Class", "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class",
  "Weight", "Rate", "Extension", "Code", "Description", "Units/Code/Class", "Weight", "Rate", "Extension",
  "smartway", "Created by", "Created Date", "Created Time", "Pick Up Address", "Final Consignee Address",
  "Carrier Email", "Tractor #", "Driver Name", "Carrier MC# Prefix", "Carrier MC #", "Carrier DOT #",
  "Carrier SCAC Code", "Carrier CA Intrastate", "Carrier CA Intrastate Exp", "Carrier TX PUC#",
  "Carrier TX PUC# Exp", "Carrier Safety Rating", "Mexican Authority (Y/N)", "Canadian Authority (Y/N)",
  "Covered Date", "Covered Time", "Future Use", "Future Use", "Office Covered By", "Customer Contact",
  "Pickup Contact", "Consignee Contact", "Currency", "Conf Rec'd Date", "Conf Rec'd Time", "Service Rep",
  "Assigned Dispatcher", "Actual Dispatcher", "Additional Ref #", "Additional Ref #", "Additional Ref #",
  "Additional Ref #", "Additional Ref #", "Additional Ref #", "Additional Ref #", "Additional Ref #",
  "Pickup Ref #", "Consignee Ref #", "Acc Charge 5", "Acc 5", "Acc Charge 6", "Acc 6", "Acc Charge 7",
  "Acc 7", "Acc Charge 8", "Acc 8", "Carrier Phone", "Carrier Dispatch Phone", "Carrier 24 Hr Phone",
  "Carrier Email 1", "Carier Email 2", "Future Use", "Proj Exp 6", "Proj Amt 6", "Type 6", "Proj Exp 7",
  "Proj Amt 7", "Type 7", "Proj Exp 8", "Proj Amt 8", "Type 8", "Proj Exp 9", "Proj Amt 9", "Type 9",
];

describe('normalizeHeader', () => {
  it('folds punctuation the same way for all variants', () => {
    expect(normalizeHeader('Pro #')).toBe('pro no');
    expect(normalizeHeader('Paid Ck# 1')).toBe('paid ck no 1');
    expect(normalizeHeader('Commis % 2')).toBe('commis pct 2');
    expect(normalizeHeader('Commis Flat $ 1')).toBe('commis flat usd 1');
    expect(normalizeHeader("Conf Rec'd Date")).toBe('conf recd date');
    expect(normalizeHeader('  Miles/Class ')).toBe('miles class');
    expect(normalizeHeader(undefined)).toBe('');
  });
});

describe('groupColumns on the 486-column layout', () => {
  const g = groupColumns(HEADERS);

  it('has 486 headers', () => {
    expect(HEADERS).toHaveLength(486);
  });

  it('detects the expected repeated-group counts', () => {
    for (const [key, n] of Object.entries(GROUP_COUNTS)) expect(g[key], key).toHaveLength(n);
  });

  it('indexes stop blocks by ordinal with 8 columns each, including the odd PS7/ref headers', () => {
    expect(g.stops.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(g.stops[0].start).toBe(194);
    expect(g.stops[11].end).toBe(289);
    for (const s of g.stops) expect(Object.keys(s.fields)).toHaveLength(8);
    expect(g.stops[6].fields.marker).toBe(242);
    expect(g.stops[2].fields.ref).toBe(217);
  });

  it('indexes 21 six-column charge lines', () => {
    expect(g.charges[0].fields).toEqual({ code: 290, description: 291, units: 292, weight: 293, rate: 294, extension: 295 });
    expect(g.charges[20].fields.extension).toBe(415);
  });

  it('pairs accessorials across the two separated runs (1-4, 5-8)', () => {
    expect(g.accessorials.map((a) => a.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.accessorials[0].fields).toEqual({ charge: 123, label: 124 });
    expect(g.accessorials[4].fields).toEqual({ charge: 460, label: 461 });
  });

  it('keeps customer payment 3 without a check number and 5 projected expenses before 4 more', () => {
    expect(g.customerPayments[2].fields).toEqual({ date: 98, amount: 99, daysToPay: 100 });
    expect(g.customerPayments[0].fields.checkNo).toBe(93);
    expect(g.projectedExpenses[0].fields).toEqual({ expense: 101, amount: 102, type: 103 });
    expect(g.projectedExpenses[8].fields).toEqual({ expense: 483, amount: 484, type: 485 });
  });

  it('indexes paid carrier expenses as 5-column blocks', () => {
    expect(g.paidExpenses[0].fields).toEqual({ name: 134, amount: 135, date: 136, checkNo: 137, gl: 138 });
    expect(g.paidExpenses[7].end).toBe(173);
  });

  it('maps the differently-named commission sub-fields onto one shape', () => {
    expect(g.commissions[0].fields).toEqual({ rep: 69, amt: 70, source: 71, gnf: 72, pct: 73, flat: 74, posted: 75 });
    expect(g.commissions[1].fields).toEqual({ rep: 76, amt: 77, source: 78, gnf: 79, pct: 80, flat: 81, posted: 82 });
    expect(g.commissions[2].fields.posted).toBe(89);
  });

  it('collects the 8 additional ref columns', () => {
    expect(g.additionalRefs.map((r) => r.start)).toEqual([450, 451, 452, 453, 454, 455, 456, 457]);
  });

  it('no column belongs to two groups and groups never swallow scalars', () => {
    const seen = new Set();
    for (const key of Object.keys(GROUP_COUNTS).concat('additionalRefs'))
      for (const grp of g[key]) for (const i of Object.values(grp.fields)) {
        expect(seen.has(i), `col ${i}`).toBe(false);
        seen.add(i);
      }
    expect(seen.size).toBe(g.claimed.size);
    for (const i of [0, 1, 52, 64, 116, 122, 416, 424, 426, 427, 428, 449, 458, 459, 468, 472]) expect(seen.has(i)).toBe(false);
  });
});

describe('scalarColumns', () => {
  const s = scalarColumns(HEADERS);

  it('resolves the identity, money, and date scalars to their positions', () => {
    expect(s.byKey).toMatchObject({
      proNo: 1, customerId: 3, customerName: 4, dispatchStatus: 13, invoiceDate: 14, shipDate: 15,
      lhRevenue: 52, balDue: 64, mode: 116, releaseDate: 117, invoiceAmount: 122, driverName: 424,
      carrierMc: 426, carrierDot: 427, carrierScac: 428, carrierId: 38, salesrepId: 11, typeOfShipment: 9,
    });
    expect(s.kinds.invoiceAmount).toBe('money');
    expect(s.kinds.shipDate).toBe('date');
  });

  it('classifies every ungrouped column; only the Future Use placeholders are unknown', () => {
    expect(s.unknown.map((u) => u.header)).toEqual(['Future Use', 'Future Use', 'Future Use', 'Future Use']);
    expect(new Set(s.unknown.map((u) => u.key)).size).toBe(4);
    const g = groupColumns(HEADERS);
    expect(Object.keys(s.byKey).length + s.unknown.length + g.claimed.size).toBe(486);
  });
});
