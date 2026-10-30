#!/usr/bin/env node
/**
 * Step P1: seed demo staff identities and trigger the demo data Lambda.
 *
 * Dev-only. Creates six temporary staff identities in the dev Cognito pool
 * (2 carrier reps, 1 carrier team lead, 1 sales rep, 1 tracker, 1 accounting),
 * each with a suppressed welcome e-mail, a never-printed random password, the
 * Step I group memberships their UserProfile role implies, and a matching
 * UserProfile row. Then calls tmsShipmentActions SEED_DEMO_DATA to create the
 * rest of the demo fixtures.
 *
 * Same CLI contract as the other TMS migration scripts: dry-run by default,
 * --plan for review, --apply --env test|sandbox|local, fingerprint validation,
 * and a hard refusal of any production outputs file or non-dev endpoint.
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createTmsClient } from './lib/tmsClient.mjs';
import { authenticateTmsUser } from './lib/tmsAuth.mjs';
import {
  parseTmsArgs,
  loadAmplifyOutputs,
  detectMode,
} from './lib/tmsConfig.mjs';
import {
  createPlan,
  loadPlan,
  savePlan,
  validatePlan,
  summarize,
} from './lib/tmsPlan.mjs';

const USAGE = `
Usage: node scripts/seedDemo.mjs --outputs <path> [options]

Options:
  --outputs <path>  Required: path to amplify_outputs.json (repo-root production file refused).
  --plan <path>     (dry-run) write plan file; (apply) read plan file.
  --env <target>    Required with --apply: test / sandbox / local. Production blocked.
  --apply           Apply the reviewed plan.
  --reset           Call RESET_DEMO_DATA before seeding.
  --remove-staff    Delete the demo staff identities (apply mode only).
`;

/**
 * The only AppSync endpoint this dev-only script will touch.
 * See scripts/devVerifyR2Followup.mjs for the same guard.
 */
const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql';

export const DEMO_STAFF = [
  { id: 'demo-carrier-rep-1@example.invalid', email: 'demo-carrier-rep-1@example.invalid', name: 'Demo Carrier Rep 1', role: 'CARRIER_REP' },
  { id: 'demo-carrier-rep-2@example.invalid', email: 'demo-carrier-rep-2@example.invalid', name: 'Demo Carrier Rep 2', role: 'CARRIER_REP' },
  { id: 'demo-carrier-team-lead@example.invalid', email: 'demo-carrier-team-lead@example.invalid', name: 'Demo Carrier Team Lead', role: 'MANAGER' },
  { id: 'demo-sales-rep@example.invalid', email: 'demo-sales-rep@example.invalid', name: 'Demo Sales Rep', role: 'CUSTOMER_REP' },
  { id: 'demo-tracker@example.invalid', email: 'demo-tracker@example.invalid', name: 'Demo Tracker', role: 'CARRIER_REP' },
  { id: 'demo-accounting@example.invalid', email: 'demo-accounting@example.invalid', name: 'Demo Accounting', role: 'AR_AP' },
];

function staffSourceRows() {
  return DEMO_STAFF.map(({ id, name, role }) => ({ id, name, role }));
}

export function buildDemoPlan({ env, endpoint, reset = false, removeStaff = false }) {
  const sourceRows = staffSourceRows();
  const actions = [];

  if (removeStaff) {
    for (const member of DEMO_STAFF) {
      actions.push({
        action: 'REMOVE_DEMO_STAFF',
        purpose: 'remove-demo-staff',
        staffId: member.id,
        input: { id: member.id },
      });
    }
  } else {
    for (const member of DEMO_STAFF) {
      actions.push({
        action: 'CREATE_DEMO_STAFF',
        purpose: 'demo-staff',
        staffId: member.id,
        input: { id: member.id, name: member.name, role: member.role },
      });
    }
    actions.push({
      action: 'SEED_DEMO_DATA',
      purpose: 'seed-demo-data',
      input: { staff: sourceRows },
    });
  }

  return createPlan({
    environment: env,
    endpoint,
    sourceType: 'demo-staff-roster',
    sourceRows,
    actions,
    reviewables: [],
    unresolved: [],
    summary: { staff: DEMO_STAFF.length, reset, removeStaff },
  });
}

export async function createDemoStaffMember({
  cognito,
  userPoolId,
  manageUsers,
  member,
  generatePassword = () => `Aa1!${randomBytes(18).toString('base64url')}`,
}) {
  const password = generatePassword();
  let created = 0;
  let username;

  try {
    const result = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: member.email,
        UserAttributes: [
          { Name: 'email', Value: member.email },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: 'SUPPRESS',
      }),
    );
    username = result.User?.Username ?? member.email;
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: username,
        Password: password,
        Permanent: true,
      }),
    );
    created = 1;
  } catch (err) {
    if (err?.name !== 'UsernameExistsException') {
      throw err;
    }
    username = member.email;
  }

  // Step I: write the UserProfile row and reconcile the Cognito groups the role implies.
  await manageUsers('setRole', { username, role: member.role });

  // The password is never returned, logged, or written to the plan.
  return { id: member.id, email: member.email, name: member.name, role: member.role, created };
}

export async function removeDemoStaffMember({ manageUsers, member }) {
  try {
    await manageUsers('delete', { username: member.email });
    return { id: member.id, removed: true };
  } catch (err) {
    const name = err?.name ?? '';
    const message = String(err?.message ?? err);
    if (name === 'UserNotFoundException' || /user.*not found/i.test(message)) {
      return { id: member.id, removed: false };
    }
    throw err;
  }
}

export async function applyDemoPlan({
  client,
  cognito,
  manageUsers,
  planPath,
  env,
  endpoint,
  outputs,
  reset,
  removeStaff,
}) {
  if (endpoint !== DEV_API) {
    throw new Error(`Refusing to run against a non-dev API: ${endpoint}`);
  }

  const plan = loadPlan(planPath);
  const sourceRows = staffSourceRows();
  validatePlan(plan, { environment: env, endpoint, sourceRows });

  const shouldReset = reset ?? plan.summary?.reset ?? false;
  const isRemoveStaff = removeStaff ?? plan.actions.some((a) => a.action === 'REMOVE_DEMO_STAFF');

  if (isRemoveStaff) {
    const staff = [];
    for (const action of plan.actions.filter((a) => a.action === 'REMOVE_DEMO_STAFF')) {
      const member = DEMO_STAFF.find((m) => m.id === action.staffId);
      if (!member) continue;
      staff.push(await removeDemoStaffMember({ manageUsers, member }));
    }
    return { environment: env, planPath, removeStaff: true, removed: staff.filter((s) => s.removed).length, staff };
  }

  const userPoolId = outputs?.auth?.user_pool_id;
  if (!userPoolId) {
    throw new Error('amplify_outputs.json missing auth.user_pool_id');
  }

  if (shouldReset) {
    await client.tmsShipmentActions('RESET_DEMO_DATA', {});
  }

  const staff = [];
  for (const action of plan.actions.filter((a) => a.action === 'CREATE_DEMO_STAFF')) {
    const member = DEMO_STAFF.find((m) => m.id === action.staffId);
    if (!member) continue;
    staff.push(
      await createDemoStaffMember({
        cognito,
        userPoolId,
        manageUsers,
        member,
      }),
    );
  }

  const seedAction = plan.actions.find((a) => a.action === 'SEED_DEMO_DATA');
  const seed = seedAction ? await client.tmsShipmentActions('SEED_DEMO_DATA', seedAction.input) : null;

  return {
    environment: env,
    planPath,
    reset: shouldReset,
    created: staff.reduce((sum, s) => sum + s.created, 0),
    staff,
    seed,
  };
}

async function main() {
  const args = parseTmsArgs({
    reset: { type: 'boolean' },
    'remove-staff': { type: 'boolean' },
  });

  if (args.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { mode, env } = detectMode(args.values.apply, args.values.env);
  const outputs = loadAmplifyOutputs(args.values.outputs);
  const endpoint = outputs?.data?.url;
  if (!endpoint) {
    throw new Error('amplify_outputs.json missing data.url');
  }

  const reset = Boolean(args.values.reset);
  const removeStaff = Boolean(args.values['remove-staff']);

  if (mode === 'dry-run') {
    const plan = buildDemoPlan({ env, endpoint, reset, removeStaff });
    const planPath = args.values.plan;
    if (planPath) {
      savePlan(plan, resolve(process.cwd(), planPath));
      console.log(`Plan written to ${planPath}`);
      console.log(summarize(plan));
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
    process.exit(0);
  }

  if (removeStaff && mode !== 'apply') {
    throw new Error('--remove-staff requires --apply');
  }

  if (!args.values.plan) {
    throw new Error('--plan <path> is required when applying');
  }

  const auth = await authenticateTmsUser(outputs);
  const client = createTmsClient({ endpoint: auth.endpoint, token: auth.token });
  const cognito = new CognitoIdentityProviderClient({ region: outputs?.auth?.aws_region });
  const manageUsers = async (action, input) => {
    const data = await client.gql(
      `query M($action: String!, $username: String, $role: String) {
        manageUsers(action: $action, username: $username, role: $role)
      }`,
      { action, username: input?.username, role: input?.role },
    );
    const raw = data?.manageUsers;
    return typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
  };

  const report = await applyDemoPlan({
    client,
    cognito,
    manageUsers,
    planPath: args.values.plan ? resolve(process.cwd(), args.values.plan) : undefined,
    env,
    endpoint,
    outputs,
    reset,
    removeStaff,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
