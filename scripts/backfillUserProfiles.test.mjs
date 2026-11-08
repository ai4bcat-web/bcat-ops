import { describe, it, expect } from 'vitest';
import {
  DEV_TABLE_SUFFIX,
  DEV_USER_POOL_ID,
  PRODUCTION_USER_POOL_ID,
  buildUserProfilePlan,
  planProfiles,
  resolvePool,
  resolveTarget,
  sourceRowsOf,
  statusOf,
} from './backfillUserProfiles.mjs';

const NOW = '2026-10-28T12:00:00.000Z';

const user = (over = {}) => ({
  username: 'rep@bcatcorp.com',
  email: 'rep@bcatcorp.com',
  enabled: true,
  status: 'CONFIRMED',
  groups: [],
  ...over,
});

describe('backfillUserProfiles — what a profile says about an existing login', () => {
  it('makes an ADMIN-group member an admin and everybody else roleless', () => {
    const { actions, byRole } = planProfiles(
      [user({ username: 'boss@bcatcorp.com', groups: ['ADMIN'] }), user()],
      [],
      NOW,
    );
    expect(byRole).toEqual({ ADMIN: 1, NONE: 1 });
    expect(actions.find((a) => a.id === 'boss@bcatcorp.com').item.role).toBe('ADMIN');
    expect(actions.find((a) => a.id === 'rep@bcatcorp.com').item.role).toBe('NONE');
  });

  it('never infers a role from a page grant — it records the grant instead', () => {
    const { actions } = planProfiles(
      [user({ groups: ['page-invoicing', 'page-carrierPay', 'DISPATCHER'] })],
      [],
      NOW,
    );
    const { item } = actions[0];
    // page-invoicing + page-carrierPay looks like AR/AP and is not: a guess here
    // would quietly rewrite somebody's access on the next role save.
    expect(item.role).toBe('NONE');
    expect(item.extraPages).toEqual(['carrierPay', 'invoicing']);
  });

  it('carries existing claims across and leaves DISPATCHER out of both lists', () => {
    const { actions } = planProfiles(
      [user({ groups: ['claim-AR_POSTING', 'DISPATCHER', 'page-loads'] })],
      [],
      NOW,
    );
    expect(actions[0].item.claims).toEqual(['AR_POSTING']);
    expect(actions[0].item.extraPages).toEqual(['loads']);
  });

  it('reads the status the Users page has always shown', () => {
    expect(statusOf(user())).toBe('ACTIVE');
    expect(statusOf(user({ enabled: false }))).toBe('INACTIVE');
    expect(statusOf(user({ status: 'FORCE_CHANGE_PASSWORD' }))).toBe('PENDING');
    // A disabled invitee is inactive, not pending: the account is switched off.
    expect(statusOf(user({ enabled: false, status: 'FORCE_CHANGE_PASSWORD' }))).toBe('INACTIVE');
  });

  it('writes nothing for a user who already has a profile', () => {
    const existing = [{ id: 'rep@bcatcorp.com', role: 'CUSTOMER_REP' }];
    const { actions, alreadyPresent } = planProfiles([user()], existing, NOW);
    expect(actions).toHaveLength(0);
    expect(alreadyPresent).toEqual([{ id: 'rep@bcatcorp.com', role: 'CUSTOMER_REP' }]);
  });

  it('is idempotent: replanning against what it wrote produces no actions', () => {
    const users = [user(), user({ username: 'boss@bcatcorp.com', groups: ['ADMIN'] })];
    const first = planProfiles(users, [], NOW);
    const written = first.actions.map((a) => a.item);
    expect(planProfiles(users, written, NOW).actions).toHaveLength(0);
  });
});

describe('backfillUserProfiles — the plan protocol', () => {
  it('fingerprints only the fields it reads, so an unrelated attribute does not invalidate it', () => {
    const rows = sourceRowsOf({ users: [user({ groups: ['page-loads', 'ADMIN'] })] });
    expect(rows).toEqual([
      {
        username: 'rep@bcatcorp.com',
        email: 'rep@bcatcorp.com',
        enabled: true,
        status: 'CONFIRMED',
        groups: ['ADMIN', 'page-loads'],
      },
    ]);
  });

  it('summarises what a reviewer has to agree to before applying', () => {
    const plan = buildUserProfilePlan({
      source: { users: [user(), user({ username: 'boss@bcatcorp.com', groups: ['ADMIN'] })], profiles: [] },
      environment: 'dev',
      suffix: DEV_TABLE_SUFFIX,
      pool: DEV_USER_POOL_ID,
      nowIso: NOW,
    });
    expect(plan.summary).toMatchObject({ users: 2, toWrite: 2, byRole: { ADMIN: 1, NONE: 1 } });
    expect(plan.actions.every((a) => a.action === 'PUT_USER_PROFILE')).toBe(true);
  });

  it('refuses the production tables and the production user pool before reading anything', () => {
    expect(() => resolveTarget('5ucwdyvwivelbo4k4jomvrwel4-NONE')).toThrow(/Refusing to run against production/);
    expect(() => resolvePool(PRODUCTION_USER_POOL_ID)).toThrow(/Refusing to read the production user pool/);
    expect(resolveTarget(undefined).suffix).toBe(DEV_TABLE_SUFFIX);
    expect(resolvePool(undefined)).toBe(DEV_USER_POOL_ID);
  });
});
