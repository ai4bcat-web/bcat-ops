#!/usr/bin/env node
/**
 * Backfill the staff directory (Step I).
 *
 * Step I makes a role DATA on `UserProfile` and projects it onto Cognito groups.
 * Everybody who already has a login predates that table: without this migration
 * the Users page shows a column of blanks, and every rep picker — which reads
 * `listUserProfiles` — has nobody to offer.
 *
 * One pass over the Cognito user pool, writing one `UserProfile` per user:
 *
 *   - `id` is the Cognito username, which for every account created through the
 *     Users page is the e-mail. That is the same value `Order.customerRepId`,
 *     `Load.carrierRepId` and `Customer.accountOwnerIds` already hold, so a
 *     picker resolves a name with a GetItem and no index.
 *   - `role` is **ADMIN for members of the ADMIN group and NONE for everybody
 *     else**. No role is inferred from a page grant: `page-invoicing` might mean
 *     AR_AP or might mean a manager who also bills, and a guessed role would
 *     silently widen or narrow somebody's access on the next role save. Ryne
 *     assigns the six roles on the Users page; until then every existing grant
 *     keeps working exactly as it does today, because the grants themselves are
 *     untouched.
 *   - `extraPages` is the user's CURRENT `page-*` grants, bare. That is the
 *     mirror the Users page prints and the set `groupsForProfile` will re-emit,
 *     so assigning a role later adds the role's pages WITHOUT dropping anything
 *     a person already had.
 *   - `claims` is their current `claim-*` groups (there are none before this
 *     deploy; read anyway, so a re-run after some claims are granted is still
 *     faithful).
 *   - `status` is ACTIVE for an enabled, CONFIRMED user, INACTIVE for a disabled
 *     one and PENDING for FORCE_CHANGE_PASSWORD — the same reading the Users
 *     page has always shown.
 *
 * What it deliberately does NOT do:
 *
 *   - it changes no Cognito group, enables and disables nobody, and deletes
 *     nothing. The only writes are `UserProfile` rows and `AuditLog` lines;
 *   - it never overwrites a profile that already exists — a row written by the
 *     Lambda since planning wins, and replaying an applied plan is a counted
 *     no-op rather than a write;
 *   - it invents no name. `name` is left unset and the UI derives a display name
 *     from the e-mail, exactly as the Users page already does.
 *
 * Dry run is the default and writes NOTHING: it prints what it would write and
 * saves a plan file when `--plan` is given. `--apply` replays that reviewed plan
 * after checking the pool has not moved underneath it.
 *
 * The guard that matters is the TABLE SUFFIX, not a flag a human types: the
 * production suffix is refused before a single read.
 *
 * Usage:
 *   node scripts/backfillUserProfiles.mjs --plan /tmp/profiles.json
 *   node scripts/backfillUserProfiles.mjs --apply --plan /tmp/profiles.json
 */
import { resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { parseTmsArgs } from './lib/tmsConfig.mjs';
import { createPlan, loadPlan, savePlan, validatePlan } from './lib/tmsPlan.mjs';

export const REGION_DEFAULT = 'us-east-1';
/** The dev stack. Every write this script makes lands here unless --suffix says otherwise. */
export const DEV_TABLE_SUFFIX = 'nc3jsnxdmjhkpequimypiatkma-NONE';
/** Production. Present anywhere in a suffix, the run stops before a single read. */
export const PRODUCTION_SUFFIX_FRAGMENT = '5ucwdyvwivelbo4k4jomvrwel4';
/** The dev user pool. The production pool is a different id and is never touched here. */
export const DEV_USER_POOL_ID = 'us-east-1_UKhMNVAG1';
export const PRODUCTION_USER_POOL_ID = 'us-east-1_IbPKPNJC9';
/** Who the audit trail says did this. Not a person: a script, named so it can be found again. */
export const MIGRATION_USER = 'migration:backfillUserProfiles';

const ADMIN_GROUP = 'ADMIN';
const PAGE_PREFIX = 'page-';
const CLAIM_PREFIX = 'claim-';

const USAGE = `Backfill UserProfile rows from the Cognito user pool (Step I).

  --suffix <s>      DynamoDB table suffix (default ${DEV_TABLE_SUFFIX});
                    the production suffix is refused.
  --pool <id>       Cognito user pool (default ${DEV_USER_POOL_ID});
                    the production pool is refused.
  --region <r>      AWS region (default ${REGION_DEFAULT}).
  --plan <path>     (dry-run) write the plan file; (apply) read it back.
  --apply           Apply the reviewed plan.

Role is ADMIN for the ADMIN group and NONE for everybody else — no role is inferred
from a page grant. Existing page grants are recorded as extraPages and left in place.`;

export function resolveTarget(value) {
  const suffix = (value ?? process.env.TABLE_SUFFIX ?? DEV_TABLE_SUFFIX).trim();
  if (!suffix) throw new Error('--suffix <tableSuffix> cannot be empty');
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(
      `Refusing to run against production tables (${suffix}): Step I is a dev-only ` +
        `build. Point it at the dev suffix (${DEV_TABLE_SUFFIX}).`
    );
  }
  return { suffix, environment: suffix === DEV_TABLE_SUFFIX ? 'dev' : suffix };
}

export function resolvePool(value) {
  const pool = (value ?? process.env.USER_POOL_ID ?? DEV_USER_POOL_ID).trim();
  if (!pool) throw new Error('--pool <userPoolId> cannot be empty');
  if (pool === PRODUCTION_USER_POOL_ID) {
    throw new Error(
      `Refusing to read the production user pool (${pool}). The dev pool is ${DEV_USER_POOL_ID}.`
    );
  }
  return pool;
}

/** PENDING, ACTIVE or INACTIVE — the reading the Users page has always shown. */
export function statusOf(user) {
  if (user.enabled === false) return 'INACTIVE';
  if (user.status === 'FORCE_CHANGE_PASSWORD' || user.status === 'RESET_REQUIRED') return 'PENDING';
  return 'ACTIVE';
}

/**
 * One profile per Cognito user. The role is read off the ADMIN group and nothing
 * else; every page grant the user holds is recorded as an extra page so that
 * assigning a role later adds to it rather than replacing it.
 */
export function planProfiles(users, existingProfiles, nowIso) {
  const existing = new Map((existingProfiles ?? []).map((row) => [String(row.id), row]));
  const actions = [];
  const alreadyPresent = [];
  const byRole = { ADMIN: 0, NONE: 0 };

  for (const user of users) {
    const id = user.username;
    if (!id) continue;
    if (existing.has(id)) {
      alreadyPresent.push({ id, role: existing.get(id)?.role ?? null });
      continue;
    }
    const groups = user.groups ?? [];
    const role = groups.includes(ADMIN_GROUP) ? 'ADMIN' : 'NONE';
    byRole[role] += 1;
    const extraPages = groups
      .filter((g) => g.startsWith(PAGE_PREFIX))
      .map((g) => g.slice(PAGE_PREFIX.length))
      .sort();
    const claims = groups
      .filter((g) => g.startsWith(CLAIM_PREFIX))
      .map((g) => g.slice(CLAIM_PREFIX.length))
      .sort();

    const item = {
      id,
      __typename: 'UserProfile',
      email: user.email ?? id,
      role,
      status: statusOf(user),
      teamKeys: [],
      claims,
      extraPages,
      createdBy: MIGRATION_USER,
      updatedBy: MIGRATION_USER,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    actions.push({
      action: 'PUT_USER_PROFILE',
      id,
      role,
      pages: extraPages.length,
      item,
    });
  }

  return { actions, alreadyPresent, byRole };
}

/** Only the fields the plan reads, so an unrelated Cognito change does not invalidate it. */
export function sourceRowsOf(source) {
  return (source.users ?? []).map((user) => ({
    username: user.username,
    email: user.email ?? null,
    enabled: user.enabled,
    status: user.status ?? null,
    groups: [...(user.groups ?? [])].sort(),
  }));
}

export function buildUserProfilePlan({ source, environment, suffix, pool, nowIso = new Date().toISOString() }) {
  const planned = planProfiles(source.users, source.profiles, nowIso);
  return createPlan({
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceType: `UserProfile rows for the Cognito users of ${pool}`,
    sourceRows: sourceRowsOf(source),
    actions: planned.actions,
    reviewables: planned.actions.map((a) => ({
      id: a.id,
      role: a.role,
      status: a.item.status,
      extraPages: a.item.extraPages,
      claims: a.item.claims,
    })),
    unresolved: [],
    summary: {
      users: source.users.length,
      existingProfiles: (source.profiles ?? []).length,
      toWrite: planned.actions.length,
      alreadyPresent: planned.alreadyPresent.length,
      byRole: planned.byRole,
    },
  });
}

export function reviewText(plan) {
  const lines = [
    `Environment: ${plan.environment}`,
    `Source:      ${plan.sourceType}`,
    `Users:       ${plan.summary.users}`,
    `Profiles:    ${plan.summary.existingProfiles} already in the table`,
    `To write:    ${plan.summary.toWrite} (ADMIN ${plan.summary.byRole.ADMIN}, NONE ${plan.summary.byRole.NONE})`,
    '',
    'Every user below gets a profile. No role is inferred from a page grant: an',
    'ADMIN-group member becomes ADMIN, everybody else becomes NONE and keeps every',
    'page they already hold as an extra grant. Assign the six TMS roles on /users.',
    '',
  ];
  for (const row of plan.reviewables) {
    const pages = row.extraPages.length ? row.extraPages.join(', ') : '(none)';
    lines.push(`  ${row.id.padEnd(34)} ${row.role.padEnd(6)} ${row.status.padEnd(9)} pages: ${pages}`);
  }
  return lines.join('\n');
}

async function scanAll(doc, tableName) {
  const items = [];
  let startKey;
  do {
    try {
      const page = await doc.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } catch (err) {
      if (err?.name === 'ResourceNotFoundException') {
        throw new Error(`Table ${tableName} does not exist — has the Step I schema been deployed to this stack?`);
      }
      throw err;
    }
  } while (startKey);
  return items;
}

async function readSource(doc, cognito, suffix, pool) {
  const users = [];
  let token;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: pool, PaginationToken: token }));
    for (const user of page.Users ?? []) {
      users.push({
        username: user.Username ?? '',
        email: user.Attributes?.find((a) => a.Name === 'email')?.Value ?? null,
        enabled: user.Enabled !== false,
        status: user.UserStatus ?? null,
        groups: [],
      });
    }
    token = page.PaginationToken;
  } while (token);

  for (const user of users) {
    const groups = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: pool, Username: user.username })
    );
    user.groups = (groups.Groups ?? []).map((g) => g.GroupName ?? '').filter(Boolean);
  }

  const profiles = await scanAll(doc, `UserProfile-${suffix}`);
  return { users, profiles };
}

async function writeAudit(doc, table, entityId, action, changes) {
  const now = new Date().toISOString();
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        id: `aud-${entityId}-${Date.now()}`,
        __typename: 'AuditLog',
        entityType: 'UserProfile',
        entityId,
        action,
        user: MIGRATION_USER,
        changes: JSON.stringify(changes),
        createdAt: now,
        updatedAt: now,
      },
    })
  );
}

export async function applyUserProfilePlan({ doc, plan, suffix }) {
  if (suffix.includes(PRODUCTION_SUFFIX_FRAGMENT)) {
    throw new Error(`Refusing to write UserProfile rows to production tables (${suffix})`);
  }
  const profileTable = `UserProfile-${suffix}`;
  const auditTable = `AuditLog-${suffix}`;
  const report = { written: 0, alreadyPresent: 0, failures: [] };

  for (const entry of plan.actions) {
    try {
      if (entry.action !== 'PUT_USER_PROFILE') throw new Error(`Unknown action ${entry.action}`);
      try {
        await doc.send(
          new PutCommand({
            TableName: profileTable,
            Item: entry.item,
            // A profile written by the Lambda since planning wins; replaying an
            // applied plan costs one refused write instead of overwriting a role
            // somebody has since assigned.
            ConditionExpression: 'attribute_not_exists(id)',
          })
        );
        report.written += 1;
        await writeAudit(doc, auditTable, entry.id, 'BACKFILL_USER_PROFILE', {
          role: entry.item.role,
          status: entry.item.status,
          extraPages: entry.item.extraPages,
          claims: entry.item.claims,
        });
      } catch (err) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        report.alreadyPresent += 1;
      }
    } catch (err) {
      report.failures.push({ action: entry.action, id: entry.id, error: err.message });
    }
  }
  return report;
}

async function main() {
  const args = parseTmsArgs({
    suffix: { type: 'string' },
    region: { type: 'string' },
    pool: { type: 'string' },
  });
  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { suffix, environment } = resolveTarget(args.values.suffix);
  const pool = resolvePool(args.values.pool);
  const region = args.values.region ?? REGION_DEFAULT;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const cognito = new CognitoIdentityProviderClient({ region });

  const source = await readSource(doc, cognito, suffix, pool);

  if (!args.values.apply) {
    const plan = buildUserProfilePlan({ source, environment, suffix, pool });
    console.log(reviewText(plan));
    if (args.values.plan) {
      savePlan(plan, resolve(process.cwd(), args.values.plan));
      console.log(`\nPlan written to ${args.values.plan} — review it, then re-run with --apply --plan ${args.values.plan}`);
    } else {
      console.log('\nDry run: nothing was written. Pass --plan <path> to save this plan, then --apply it.');
    }
    process.exit(0);
  }

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying: apply replays a plan a person has read');
  }
  const plan = loadPlan(resolve(process.cwd(), args.values.plan));
  validatePlan(plan, {
    environment,
    endpoint: `dynamodb://${REGION_DEFAULT}/${suffix}`,
    sourceRows: sourceRowsOf(source),
  });

  const report = await applyUserProfilePlan({ doc, plan, suffix });
  console.log(JSON.stringify({ environment, suffix, pool, ...report }, null, 2));
  if (report.failures.length > 0) process.exit(2);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
