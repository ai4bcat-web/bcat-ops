import { describe, it, expect } from 'vitest';
import {
  CLAIM_ORIGIN,
  DEV_TABLE_SUFFIX,
  MIGRATION_USER,
  OWNER_EMAIL,
  applyProClaimPlan,
  buildProClaimPlan,
  identityOf,
  planProClaims,
  readSource,
  replanAfterApply,
  requireAdminIdentity,
  resolveTarget,
  reviewText,
  sourceRowsOf,
} from './backfillProClaims.mjs';
import { validatePlan } from './lib/tmsPlan.mjs';

const NOW = '2026-10-29T12:00:00.000Z';

/**
 * A stand-in for the two tables this migration touches. What it has to be faithful
 * about is the single rule the claim rests on: a conditional put on an id that already
 * exists is refused, which is what makes a PRO claimable exactly once.
 */
function fakeTables({ loads = [], claims = [] } = {}) {
  const tables = {
    [`Load-${DEV_TABLE_SUFFIX}`]: new Map(loads.map((l) => [String(l.id), { ...l }])),
    [`ProClaim-${DEV_TABLE_SUFFIX}`]: new Map(claims.map((c) => [String(c.id), { ...c }])),
  };
  const puts = [];
  return {
    tables,
    puts,
    claimRows: () => [...tables[`ProClaim-${DEV_TABLE_SUFFIX}`].values()],
    send: async (cmd) => {
      const table = tables[cmd.input.TableName];
      if (!table) {
        const err = new Error(`no table ${cmd.input.TableName}`);
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      if (cmd.input.Item) {
        puts.push(cmd.input);
        if (cmd.input.ConditionExpression === 'attribute_not_exists(id)' && table.has(String(cmd.input.Item.id))) {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        table.set(String(cmd.input.Item.id), { ...cmd.input.Item });
        return {};
      }
      return { Items: [...table.values()] };
    },
  };
}

function legacyLoad(id, aljexId, extra = {}) {
  return {
    id,
    aljexId,
    shipmentId: `shp-${id}`,
    createdAt: `2024-03-0${id.slice(-1)}T08:00:00.000Z`,
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...extra,
  };
}

const build = (source) => buildProClaimPlan({ source, environment: 'dev', suffix: DEV_TABLE_SUFFIX, now: NOW });

describe('backfillProClaims — the production guard', () => {
  it('refuses the production suffix before a single read', () => {
    expect(() => resolveTarget(`Load-5ucwdyvwivelbo4k4jomvrwel4-NONE`)).toThrow(/Refusing to run against production/);
    expect(resolveTarget(DEV_TABLE_SUFFIX)).toEqual({ suffix: DEV_TABLE_SUFFIX, environment: 'dev' });
  });

  it('refuses to write to production even with a plan in hand', async () => {
    const plan = build({ Load: [legacyLoad('l1', '14547')], ProClaim: [] });
    await expect(
      applyProClaimPlan({ doc: fakeTables(), plan, suffix: 'ProClaim-5ucwdyvwivelbo4k4jomvrwel4-NONE' }),
    ).rejects.toThrow(/Refusing to write/);
  });
});

describe('backfillProClaims — who may claim every PRO on the board', () => {
  const tokenFor = (claims) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

  it('reads the owner and the ADMIN group off the token the run signed in with', () => {
    expect(identityOf(tokenFor({ email: OWNER_EMAIL })).isAdmin).toBe(true);
    expect(identityOf(tokenFor({ email: 'dennis@bcatcorp.com', 'cognito:groups': ['ADMIN'] })).isAdmin).toBe(true);
    // Cognito hands the claim back as a comma string on some flows.
    expect(identityOf(tokenFor({ email: 'd@x.com', 'cognito:groups': 'CUSTOMER_REP,ADMIN' })).isAdmin).toBe(true);
    expect(identityOf(tokenFor({ email: 'rep@bcatcorp.com', 'cognito:groups': ['CUSTOMER_REP'] })).isAdmin).toBe(false);
  });

  it('refuses a non-admin by name, because nothing downstream would', () => {
    // The writes are IAM-signed DynamoDB puts: no Lambda sees this run, so this is the
    // only place the rule can be enforced at all.
    expect(() => requireAdminIdentity(tokenFor({ email: 'rep@bcatcorp.com', 'cognito:groups': ['CUSTOMER_REP'] })))
      .toThrow(/requires the owner or an ADMIN.*rep@bcatcorp.com/s);
    expect(() => requireAdminIdentity(tokenFor({ email: OWNER_EMAIL }))).not.toThrow();
  });
});

describe('backfillProClaims — which PROs get claimed', () => {
  it('claims the normalized PRO, so a padded spelling and a typed one are one key', () => {
    const planned = planProClaims({
      loads: [legacyLoad('l1', '14547  '), legacyLoad('l2', '98210')],
      claims: [],
      now: NOW,
    });
    expect(planned.actions.map((a) => a.pro)).toEqual(['14547', '98210']);
  });

  it('claims a voided load too — a voided PRO is the one that must never come back', () => {
    const planned = planProClaims({
      loads: [legacyLoad('l1', '14547', { voidedAt: '2025-06-01T00:00:00.000Z' })],
      claims: [],
      now: NOW,
    });
    expect(planned.actions.map((a) => ({ pro: a.pro, voided: a.voided }))).toEqual([{ pro: '14547', voided: true }]);
    expect(planned.voidedLoads).toBe(1);
  });

  it('skips a PRO that normalizes to nothing and says which load carried what', () => {
    const planned = planProClaims({
      loads: [
        legacyLoad('l1', '   '),
        legacyLoad('l2', 'N/A'),
        legacyLoad('l3', '12'),
        legacyLoad('l4', null),
        legacyLoad('l5', '14547'),
      ],
      claims: [],
      now: NOW,
    });
    expect(planned.actions.map((a) => a.loadId)).toEqual(['l5']);
    expect(planned.unclaimable.map((r) => [r.loadId, r.aljexId])).toEqual([
      ['l1', '   '],
      ['l2', 'N/A'],
      ['l3', '12'],
      ['l4', null],
    ]);
  });

  it('reports two loads on one PRO instead of dropping the second', () => {
    const planned = planProClaims({
      loads: [legacyLoad('l1', '14547  '), legacyLoad('l2', 'pro #14547'), legacyLoad('l3', '98210')],
      claims: [],
      now: NOW,
    });

    expect(planned.actions.map((a) => [a.pro, a.loadId])).toEqual([['14547', 'l1'], ['98210', 'l3']]);
    expect(planned.collisions).toEqual([
      expect.objectContaining({ pro: '14547', holderLoadId: 'l1', loadIds: ['l1', 'l2'] }),
    ]);
    // The loser is named with the text it actually carries, so a person can go look.
    expect(planned.collisions[0].contenders.map((c) => c.aljexId)).toEqual(['pro #14547']);
  });

  it('calls a claim that already names another load a collision, not a quiet skip', () => {
    const planned = planProClaims({
      loads: [legacyLoad('l9', '14547')],
      claims: [{ id: '14547', loadId: 'l1', claimedAt: NOW, claimedBy: 'router', origin: 'CREATE' }],
      now: NOW,
    });
    expect(planned.actions).toEqual([]);
    expect(planned.collisions[0]).toMatchObject({ pro: '14547', holderLoadId: 'l1', holderIsExistingClaim: true, loadIds: ['l1', 'l9'] });
  });

  it('carries the six counts a reviewer decides on', () => {
    const plan = build({
      Load: [
        legacyLoad('l1', '14547  '),
        legacyLoad('l2', 'PRO 14547'),
        legacyLoad('l3', '98210', { voidedAt: '2025-06-01T00:00:00.000Z' }),
        legacyLoad('l4', ' '),
        legacyLoad('l5', '77321'),
      ],
      ProClaim: [{ id: '77321', loadId: 'l5', claimedAt: NOW, claimedBy: 'router', origin: 'CREATE' }],
    });

    expect(plan.summary).toMatchObject({
      loadsScanned: 5,
      voidedLoads: 1,
      claimsToWrite: 2,
      alreadyClaimed: 1,
      unclaimable: 1,
      collisions: 1,
    });
    // Both the duplicate and the unclaimable row reach a person, by name.
    expect(plan.reviewables.map((r) => r.kind).sort()).toEqual(['PRO_COLLISION', 'PRO_UNCLAIMABLE']);
    const review = reviewText(plan);
    expect(review).toMatch(/14547: l1, l2 — claim goes to l1/);
    expect(review).toMatch(/l4 — aljexId " "/);
  });
});

describe('backfillProClaims — apply', () => {
  const loads = [
    legacyLoad('l1', '14547  '),
    legacyLoad('l2', 'pro#14547'),
    legacyLoad('l3', '98210', { voidedAt: '2025-06-01T00:00:00.000Z' }),
    legacyLoad('l4', 'N/A'),
    legacyLoad('l5', '77321', { shipmentId: null }),
  ];

  it('writes one claim per PRO under the normalized key and claims the voided one', async () => {
    const doc = fakeTables({ loads });
    const plan = build(await readSource(doc, DEV_TABLE_SUFFIX));

    const report = await applyProClaimPlan({ doc, plan, suffix: DEV_TABLE_SUFFIX });

    expect(report).toMatchObject({ claimsWritten: 3, alreadyClaimed: 0, failures: [] });
    const rows = doc.claimRows().sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((r) => [r.id, r.loadId, r.origin])).toEqual([
      ['14547', 'l1', CLAIM_ORIGIN],
      ['77321', 'l5', CLAIM_ORIGIN],
      ['98210', 'l3', CLAIM_ORIGIN],
    ]);
    // The claim records when the number went out, not when the migration ran.
    expect(rows[0].claimedAt).toBe('2024-03-01T08:00:00.000Z');
    expect(rows[0].claimedBy).toBe(MIGRATION_USER);
    // A load that belongs to no shipment yet leaves the attribute off rather than
    // writing a NULL into it.
    expect('shipmentId' in rows[1]).toBe(false);
    expect(doc.puts.every((p) => p.ConditionExpression === 'attribute_not_exists(id)')).toBe(true);
  });

  it('writes nothing on a second run, and a re-plan reports zero to write', async () => {
    const doc = fakeTables({ loads });
    const first = build(await readSource(doc, DEV_TABLE_SUFFIX));
    await applyProClaimPlan({ doc, plan: first, suffix: DEV_TABLE_SUFFIX });

    const after = await replanAfterApply(doc, DEV_TABLE_SUFFIX);
    expect(after).toMatchObject({ claimsToWrite: 0, alreadyClaimed: 3, unclaimable: 1, collisions: 1, voidedLoads: 1 });

    // Replaying the very same plan file is harmless: every put is refused by the
    // condition, which is also what happens when the router claimed a PRO in between.
    const replay = await applyProClaimPlan({ doc, plan: first, suffix: DEV_TABLE_SUFFIX });
    expect(replay).toMatchObject({ claimsWritten: 0, alreadyClaimed: 3, failures: [] });
    expect(doc.claimRows()).toHaveLength(3);

    const second = build(await readSource(doc, DEV_TABLE_SUFFIX));
    expect(second.actions).toEqual([]);
    expect(reviewText(second)).toMatch(/Nothing to write/);
  });

  it('refuses to apply against rows that moved after the plan was built', async () => {
    const doc = fakeTables({ loads });
    const source = await readSource(doc, DEV_TABLE_SUFFIX);
    const plan = build(source);
    const target = { environment: 'dev', endpoint: plan.endpoint, sourceRows: sourceRowsOf(source) };

    expect(() => validatePlan(plan, target)).not.toThrow();

    // A load renamed onto another PRO between plan and apply changes which number this
    // run would claim forever, so the plan must not be replayable.
    const moved = { ...source, Load: source.Load.map((l) => (l.id === 'l1' ? { ...l, aljexId: '20099' } : l)) };
    expect(() => validatePlan(plan, { ...target, sourceRows: sourceRowsOf(moved) })).toThrow(/fingerprint mismatch/);
  });

  it('reports a failed claim without abandoning the rest', async () => {
    const doc = fakeTables({ loads });
    const plan = build(await readSource(doc, DEV_TABLE_SUFFIX));
    const real = doc.send;
    doc.send = async (cmd) => {
      if (cmd.input.Item?.id === '14547') throw new Error('ProvisionedThroughputExceededException');
      return real(cmd);
    };

    const report = await applyProClaimPlan({ doc, plan, suffix: DEV_TABLE_SUFFIX });

    expect(report.claimsWritten).toBe(2);
    expect(report.failures).toEqual([
      { action: 'CLAIM_PRO', pro: '14547', loadId: 'l1', error: 'ProvisionedThroughputExceededException' },
    ]);
  });
});
