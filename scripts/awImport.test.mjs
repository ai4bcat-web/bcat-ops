import { describe, expect, it } from 'vitest';
import { assertTarget, bundleCore, prepareUpload } from './awImport.mjs';
import { PRODUCTION, STACK } from './lib/stackConfig.mjs';

const core = await bundleCore();
const csv = (rows) => `${rows.map((r) => r.join(',')).join('\n')}\n`;
const customersHeaders = Object.values(core.CUSTOMER_COLUMNS);
const carriersHeaders = Object.values(core.CARRIER_COLUMNS);

describe('prepareUpload', () => {
  it('drops the Web Password column of a customers file: the uploaded copy carries neither the header nor the value', () => {
    const row = customersHeaders.map((h) => (h === 'Account #' ? '900001' : h === 'Name' ? 'Northwind Foods' : 'x'));
    const out = prepareUpload(core, 'CUSTOMERS_MASTER', csv([[...customersHeaders, 'Web Password'], [...row, 'CANARY-SECRET']]));
    expect(out.dropped).toEqual(['Web Password']);
    expect(out.csv).not.toMatch(/CANARY|Web Password/);
    expect(core.parseCsvRows(out.csv)[0]).toEqual(customersHeaders);
  });

  it('drops Fed/SS #, Bank Account, Routing # and the tax-id-shaped Account # of a carriers file', () => {
    const extra = ['Fed/SS #', 'Bank Account', 'Routing #', 'Account #'];
    const row = carriersHeaders.map(() => 'x');
    const out = prepareUpload(core, 'CARRIERS_MASTER', csv([[...carriersHeaders, ...extra], [...row, 'CANARY-1', 'CANARY-2', 'CANARY-3', 'CANARY-4']]));
    expect(out.dropped).toEqual(extra);
    expect(out.csv).not.toMatch(/CANARY|Fed\/SS|Bank Account|Routing/);
  });

  it('refuses a file of the wrong kind', () => {
    expect(() => prepareUpload(core, 'CUSTOMERS_MASTER', 'a,b\n1,2\n')).toThrow(/not a Customer list/);
  });
});

describe('assertTarget', () => {
  it('needs a named stack and the selected stack\'s own API', () => {
    expect(() => assertTarget({ env: {}, stack: STACK, outputs: { data: { url: STACK.apiUrl } } })).toThrow(/Name the target/);
    expect(() => assertTarget({ env: { BCAT_STACK: 'dev' }, stack: STACK, outputs: { data: { url: 'https://other/graphql' } } })).toThrow(/not the API/);
    expect(() => assertTarget({ env: { BCAT_STACK: 'dev' }, stack: STACK, outputs: { data: { url: STACK.apiUrl } } })).not.toThrow();
  });

  it('refuses a stack that resolves to production', () => {
    const prod = { ...STACK, apiId: PRODUCTION.apiId, apiUrl: 'https://p/graphql' };
    expect(() => assertTarget({ env: { BCAT_STACK: 'dev' }, stack: prod, outputs: { data: { url: prod.apiUrl } } })).toThrow(/production/);
  });
});
