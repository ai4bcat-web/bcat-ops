import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, planRelease, releaseGate, releaseOne } from './awRelease.mjs';
import { RELEASE_FIELDS, classifyShipment, indexExport, parseAljexDate, releasePatch } from './lib/releaseClassify.mjs';
import { PROD_WRITE_SETS } from './lib/prodWriteSets.mjs';
import { resolveScripts } from './prodBackup.mjs';
import { ALLOW_ENV, PROD_SUFFIX } from './lib/prodGate.mjs';

const exportRows = (rows) => indexExport(rows.map(([pro, release, invoice, status = 'DELIVERED']) => ({ pro, release, invoice, status }))).byPro;
const ship = (over = {}) => ({ id: 's1', number: '12345', status: 'DELIVERED', ...over });
const order = (over = {}) => ({ id: 'o1', shipmentId: 's1', arStatus: 'DOCS_NEEDED', version: 3, ...over });
const classify = (over = {}) => classifyShipment({
  shipment: ship(), orders: [order()], keys: ['12345'], exportByPro: exportRows([['12345', '03/04/25', '03/06/25']]),
  hasInvoice: false, hasApprovedBill: false, ...over,
});

describe('classifyShipment', () => {
  it('Aljex Release + Invoice date on a DOCS_NEEDED order is TO_RELEASE', () => {
    expect(classify()).toMatchObject({ category: 'TO_RELEASE', source: 'ALJEX_RELEASE_DATE', releaseDate: '2025-03-04', invoiceDate: '2025-03-06' });
  });
  it.each([
    [{ arStatus: 'PAID', invoiceId: 'i1' }],
    [{ arStatus: 'UNBILLED' }],
    [{ arStatus: 'DOCS_NEEDED', readyToInvoiceAt: '2026-11-01T00:00:00Z' }],
  ])('an order the app already treats as released is ALREADY_RELEASED, not rewritten (%j)', (o) => {
    expect(classify({ orders: [order(o)] }).category).toBe('ALREADY_RELEASED');
  });
  it('the three review sets stay DELIVERED and are listed', () => {
    for (const [rel, inv] of [['03/04/25', ''], ['', '03/06/25'], ['', '']]) {
      expect(classify({ exportByPro: exportRows([['12345', rel, inv]]) }).category).toBe('REVIEW');
    }
  });
  it('an Aljex row that is not DELIVERED and has no dates stays DELIVERED without review', () => {
    expect(classify({ exportByPro: exportRows([['12345', '', '', 'COVERED']]) }).category).toBe('STAY_DELIVERED');
  });
  it('no export row: an Invoice or an approved carrier bill releases, otherwise UNKNOWN', () => {
    const none = { exportByPro: new Map() };
    expect(classify({ ...none, hasInvoice: true })).toMatchObject({ category: 'TO_RELEASE', source: 'FALLBACK_INVOICE' });
    expect(classify({ ...none, hasApprovedBill: true })).toMatchObject({ category: 'TO_RELEASE', source: 'FALLBACK_CARRIER_BILL' });
    expect(classify({ ...none }).category).toBe('UNKNOWN');
  });
  it('a shipment in any other status is never a candidate, even with a Release Date', () => {
    const c = classify({ shipment: ship({ status: 'OPEN' }) });
    expect(c.category).toBe('OTHER_STATUS');
    expect(c.order).toBeNull();
  });
  it('a voided shipment is left alone and a multi-order shipment goes to review', () => {
    expect(classify({ shipment: ship({ voidedAt: '2026-01-01' }) }).category).toBe('STAY_DELIVERED');
    expect(classify({ orders: [order(), order({ id: 'o2' })] }).category).toBe('REVIEW');
  });
});

describe('matching + dates', () => {
  it('matches Shipment.number, Load.aljexId and a padded/prefixed PRO to the export PRO', () => {
    const base = { shipments: [ship({ number: 'S000001-1' })], orders: [order()], claims: [], invoices: [], bills: [] };
    const rows = [{ pro: 'pro# 9471 ', release: '1/2/24', invoice: '1/3/24', status: 'DELIVERED' }];
    const viaLoad = planRelease({ ...base, loads: [{ shipmentId: 's1', aljexId: '9471  ' }], exportRows: rows });
    expect(viaLoad.counts.TO_RELEASE).toBe(1);
    const noKey = planRelease({ ...base, loads: [], exportRows: rows });
    expect(noKey.counts.UNKNOWN).toBe(1);
  });
  it('parses MM/DD/YY and rejects junk', () => {
    expect(parseAljexDate('01/05/24')).toBe('2024-01-05');
    expect(parseAljexDate('')).toBeNull();
    expect(parseAljexDate('13/40/24')).toBeNull();
  });
});

describe('release patch', () => {
  it('writes exactly the release fields and no money field', () => {
    const p = releasePatch({ source: 'ALJEX_RELEASE_DATE', releaseDate: '2025-03-04' }, order(), '2026-11-08T00:00:00.000Z');
    expect(Object.keys(p).sort()).toEqual([...RELEASE_FIELDS].sort());
    expect(p).toMatchObject({ arStatus: 'LEGACY', readyToInvoiceAt: '2025-03-04T12:00:00.000Z', version: 4 });
    expect(releasePatch({ source: 'FALLBACK_CARRIER_BILL' }, order(), 'N').arStatus).toBe('UNBILLED');
  });
});

describe('releaseOne', () => {
  const recorder = (fail = false) => ({
    sent: [],
    async send(cmd) {
      this.sent.push(cmd);
      if (fail && cmd.constructor.name === 'UpdateCommand') throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
      return {};
    },
  });
  const entry = () => ({ shipment: ship(), c: classify() });
  const dev = 'nc3jsnxdmjhkpequimypiatkma-NONE';

  it('updates only the Order, conditioned on the DOCS_NEEDED/no-invoice state, plus one audit row with the previous state', async () => {
    const doc = recorder();
    expect(await releaseOne({ doc, suffix: dev, entry: entry() })).toBe('written');
    expect(doc.sent.map((c) => c.input.TableName)).toEqual([`Order-${dev}`, `AuditLog-${dev}`]);
    const cond = doc.sent[0].input.ConditionExpression;
    expect(cond).toContain('arStatus = :prev');
    expect(cond).toContain('invoiceId');
    const audit = doc.sent[1].input.Item;
    expect(audit).toMatchObject({ entityType: 'SHIPMENT', entityId: 's1', action: AUDIT_ACTION });
    expect(JSON.parse(audit.changes).previous.arStatus).toBe('DOCS_NEEDED');
  });
  it('a lost race writes nothing else (no audit row)', async () => {
    const doc = recorder(true);
    expect(await releaseOne({ doc, suffix: dev, entry: entry() })).toBe('changed');
    expect(doc.sent).toHaveLength(1);
  });
  it('refuses production tables without the gate', async () => {
    await expect(releaseOne({ doc: recorder(), suffix: PROD_SUFFIX, entry: entry() })).rejects.toThrow(/without --target prod/);
  });
});

describe('write set + production gate', () => {
  it('backs up exactly Order and AuditLog and prodBackup accepts the script', () => {
    expect(PROD_WRITE_SETS.awRelease.models).toEqual(['Order', 'AuditLog']);
    expect(resolveScripts('awRelease')).toEqual(['awRelease']);
  });

  const NOW = new Date(2026, 10, 8, 12, 0, 0);
  const TODAY = '2026-11-08';
  const ACCT = '111122223333';
  const backups = (names) => ({
    async send(cmd) {
      const t = cmd.input.TableName;
      return { BackupSummaries: names.includes(t.split('-')[0]) ? [{ TableName: t, BackupName: `prodpre-awRelease-${t}-x`, BackupStatus: 'AVAILABLE', BackupCreationDateTime: new Date(NOW.getTime() - 600000) }] : [] };
    },
  });
  const run = (over = {}, valueOver = {}) => releaseGate(
    { target: 'prod', 'i-mean-production': true, apply: true, 'confirm-prod': `${ACCT}:${PROD_SUFFIX}`, ...valueOver },
    { env: { [ALLOW_ENV]: TODAY, AW_PROD_CONFIRM: `${TODAY}-release` }, now: NOW, accountId: async () => ACCT, dynamo: backups(['Order', 'AuditLog']), out: () => {}, ...over },
  );

  it('opens only with every condition', async () => {
    expect(await run()).toMatchObject({ apply: true, suffix: PROD_SUFFIX });
  });
  it.each([
    ['BCAT_ALLOW_PROD missing', { env: { AW_PROD_CONFIRM: `${TODAY}-release` } }, {}, /BCAT_ALLOW_PROD/],
    ['stale/missing backup of AuditLog', { dynamo: backups(['Order']) }, {}, /backup/],
    ['no --i-mean-production', {}, { 'i-mean-production': false }, /i-mean-production/],
    ['wrong typed confirmation', {}, { 'confirm-prod': `${ACCT}:wrong` }, /typed confirmation/],
    ['AW_PROD_CONFIRM missing', { env: { [ALLOW_ENV]: TODAY } }, {}, /AW_PROD_CONFIRM must equal 2026-11-08-release/],
    ['AW_PROD_CONFIRM for another day', { env: { [ALLOW_ENV]: TODAY, AW_PROD_CONFIRM: '2026-11-07-release' } }, {}, /AW_PROD_CONFIRM/],
  ])('refuses an apply: %s', async (_n, over, valueOver, re) => {
    await expect(run(over, valueOver)).rejects.toThrow(re);
  });
  it('a dry run needs neither backups nor AW_PROD_CONFIRM', async () => {
    const g = await run({ env: { [ALLOW_ENV]: TODAY }, dynamo: backups([]) }, { apply: false, 'confirm-prod': undefined });
    expect(g.apply).toBe(false);
  });
});
