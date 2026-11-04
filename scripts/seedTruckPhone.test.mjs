import { describe, it, expect } from 'vitest';
import {
  DRIVER_NAME, PRODUCTION_SUFFIX_FRAGMENT, assertDevTarget, describePlan, mask, parseArgs, planTruckPhone, toE164,
} from './seedTruckPhone.mjs';

const FICTIONAL = '+13125550142';
const drivers = [{ id: 'd1', name: DRIVER_NAME, assignedTruckId: 't1' }, { id: 'd2', name: 'Someone Else', assignedTruckId: 't2' }];
const equipment = [{ id: 't1', type: 'truck', unitNumber: '12' }, { id: 't2', type: 'truck', unitNumber: '14' }];

describe('seed truck phone', () => {
  it('refuses a production table suffix and a non-dev endpoint', () => {
    expect(() => assertDevTarget({ suffix: `x${PRODUCTION_SUFFIX_FRAGMENT}-NONE` })).toThrow(/production/);
    expect(() => assertDevTarget({ endpoint: 'https://example.appsync-api.us-east-1.amazonaws.com/graphql' })).toThrow(/non-dev/);
    expect(() => assertDevTarget({ endpoint: 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql' })).not.toThrow();
  });

  it('refuses when the driver is missing or ambiguous, naming ids only', () => {
    const none = planTruckPhone({ drivers: [], equipment, configs: [], phone: FICTIONAL });
    expect(none).toMatchObject({ ok: false, code: 2 });
    const twins = planTruckPhone({ drivers: [...drivers, { id: 'd3', name: DRIVER_NAME }], equipment, configs: [], phone: FICTIONAL });
    expect(twins).toMatchObject({ ok: false, code: 2 });
    expect(twins.error).toContain('d1');
    expect(twins.error).toContain('d3');
  });

  it('refuses when the driver has no truck, unless --truck names one (and never reassigns)', () => {
    const noTruck = [{ id: 'd1', name: DRIVER_NAME, assignedTruckId: null }];
    expect(planTruckPhone({ drivers: noTruck, equipment, configs: [], phone: FICTIONAL })).toMatchObject({ ok: false, code: 2 });
    const named = planTruckPhone({ drivers: noTruck, equipment, configs: [], truckUnit: '14', phone: FICTIONAL });
    expect(named).toMatchObject({ ok: true, action: 'create', truck: { id: 't2' } });
    expect(Object.keys(named.input).sort()).toEqual(['phone', 'phoneLabel', 'truckId', 'unitNumber']);
  });

  it('plans an update for an existing TruckConfig, create otherwise, and is idempotent', () => {
    const base = { drivers, equipment, phone: FICTIONAL };
    expect(planTruckPhone({ ...base, configs: [] }).action).toBe('create');
    expect(planTruckPhone({ ...base, configs: [{ truckId: 't1', phone: null }] }).action).toBe('update');
    const set = planTruckPhone({ ...base, configs: [] }).input;
    expect(planTruckPhone({ ...base, configs: [{ ...set }] }).action).toBe('unchanged');
  });

  it('--revert plans a null write', () => {
    const plan = planTruckPhone({ drivers, equipment, configs: [{ truckId: 't1', phone: FICTIONAL, phoneLabel: 'x' }], revert: true });
    expect(plan).toMatchObject({ ok: true, action: 'update', input: { truckId: 't1', phone: null, phoneLabel: null } });
  });

  it('prints the number masked, never raw', () => {
    const plan = planTruckPhone({ drivers, equipment, configs: [], phone: FICTIONAL });
    const line = describePlan(plan, false);
    expect(line).toContain('***-***-0142');
    expect(line).not.toContain('3125550142');
    expect(mask(FICTIONAL)).toBe('***-***-0142');
  });

  it('takes the number from --phone or AJK_SEED_PHONE and accepts only a US number', () => {
    expect(parseArgs(['--phone=(312) 555-0142'], {}).phone).toBe('(312) 555-0142');
    expect(parseArgs([], { AJK_SEED_PHONE: FICTIONAL }).phone).toBe(FICTIONAL);
    expect(toE164('(312) 555-0142')).toBe(FICTIONAL);
    expect(toE164('1 312 555 0142')).toBe(FICTIONAL);
    expect(toE164('555-0142')).toBeNull();
    expect(toE164('+442071838750')).toBeNull();
  });
});
