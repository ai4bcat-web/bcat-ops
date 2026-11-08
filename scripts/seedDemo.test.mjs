import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DEMO_STAFF,
  buildDemoPlan,
  applyDemoPlan,
} from './seedDemo.mjs';
import { loadAmplifyOutputs, detectMode } from './lib/tmsConfig.mjs';
import { savePlan } from './lib/tmsPlan.mjs';

const DEV_API = 'https://f5iqzdpidzalvjys7yxijn5ave.appsync-api.us-east-1.amazonaws.com/graphql';

function createFakeCognito(seed = []) {
  const users = new Map();
  for (const u of seed) {
    users.set(u.username, { username: u.username, email: u.email ?? u.username, groups: [] });
  }
  return {
    send: vi.fn(async (command) => {
      if (command instanceof AdminCreateUserCommand) {
        const username = command.input.Username;
        if (users.has(username)) {
          const err = new Error('User already exists');
          err.name = 'UsernameExistsException';
          throw err;
        }
        users.set(username, { username, email: username, groups: [] });
        return { User: { Username: username } };
      }
      if (command instanceof AdminSetUserPasswordCommand) {
        return {};
      }
      if (command instanceof AdminDeleteUserCommand) {
        users.delete(command.input.Username);
        return {};
      }
      throw new Error(`Unexpected Cognito command: ${command.constructor.name}`);
    }),
    _users: users,
  };
}

function createFakeManageUsers() {
  return vi.fn(async (action, input) => {
    if (action === 'setRole') {
      return { success: true, profile: { id: input.username, role: input.role } };
    }
    if (action === 'delete') {
      if (input.username === 'missing@example.invalid') {
        const err = new Error('User not found');
        err.name = 'UserNotFoundException';
        throw err;
      }
      return { success: true };
    }
    throw new Error(`Unexpected manageUsers action: ${action}`);
  });
}

function createFakeClient(seedResult = { customers: 3, shipments: 40 }) {
  return {
    tmsShipmentActions: vi.fn(async (action, input) => {
      if (action === 'RESET_DEMO_DATA') return { reset: true };
      if (action === 'SEED_DEMO_DATA') return seedResult;
      throw new Error(`Unexpected tmsShipmentActions action: ${action}`);
    }),
  };
}

describe('seedDemo guards', () => {
  it('refuses repo-root amplify_outputs.json', () => {
    expect(() => loadAmplifyOutputs('amplify_outputs.json')).toThrow(/Refusing to use repo-root/);
  });

  it('refuses --apply without --env', () => {
    expect(() => detectMode(true, undefined)).toThrow(/--env .* is required/);
  });

  it('refuses a blocked env', () => {
    expect(() => detectMode(true, 'prod')).toThrow(/blocked/);
  });

  it('refuses a non-dev endpoint on apply', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tms-seed-demo-'));
    try {
      const plan = buildDemoPlan({ env: 'test', endpoint: DEV_API });
      const planPath = join(tmpDir, 'plan.json');
      savePlan(plan, planPath);
      await expect(
        applyDemoPlan({
          client: createFakeClient(),
          cognito: createFakeCognito(),
          manageUsers: createFakeManageUsers(),
          planPath,
          env: 'test',
          endpoint: 'https://prod.example.com/graphql',
          outputs: { auth: { user_pool_id: 'test-pool' } },
        }),
      ).rejects.toThrow(/non-dev API/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses a plan fingerprint mismatch', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tms-seed-demo-'));
    try {
      const plan = buildDemoPlan({ env: 'test', endpoint: DEV_API });
      plan.sourceRows = 99;
      plan.fingerprint = 'sha256:deadbeef';
      const planPath = join(tmpDir, 'plan.json');
      savePlan(plan, planPath);
      await expect(
        applyDemoPlan({
          client: createFakeClient(),
          cognito: createFakeCognito(),
          manageUsers: createFakeManageUsers(),
          planPath,
          env: 'test',
          endpoint: DEV_API,
          outputs: { auth: { user_pool_id: 'test-pool' } },
        }),
      ).rejects.toThrow(/fingerprint mismatch/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('seedDemo apply', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-seed-demo-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function planToPath(plan) {
    const path = join(tmpDir, 'plan.json');
    savePlan(plan, path);
    return path;
  }

  it('builds the six-role staff roster and never returns a password', async () => {
    const plan = buildDemoPlan({ env: 'test', endpoint: DEV_API });
    const cognito = createFakeCognito();
    const manageUsers = createFakeManageUsers();
    const client = createFakeClient();
    const report = await applyDemoPlan({
      client,
      cognito,
      manageUsers,
      planPath: planToPath(plan),
      env: 'test',
      endpoint: DEV_API,
      outputs: { auth: { user_pool_id: 'test-pool' } },
    });

    expect(report.created).toBe(6);
    expect(report.staff).toHaveLength(DEMO_STAFF.length);
    expect(report.staff.map((s) => s.role).sort()).toEqual([
      'AR_AP',
      'CARRIER_REP',
      'CARRIER_REP',
      'CARRIER_REP',
      'CUSTOMER_REP',
      'MANAGER',
    ]);
    expect(report.staff.some((s) => 'password' in s)).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/password/i);
    expect(manageUsers).toHaveBeenCalledTimes(6);
    for (const member of DEMO_STAFF) {
      expect(manageUsers).toHaveBeenCalledWith('setRole', { username: member.email, role: member.role });
    }
    expect(cognito.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ MessageAction: 'SUPPRESS' }),
      }),
    );
    expect(report.seed).toEqual({ customers: 3, shipments: 40 });
  });

  it('reports created: 0 on a second run', async () => {
    const plan = buildDemoPlan({ env: 'test', endpoint: DEV_API });
    const cognito = createFakeCognito();
    const manageUsers = createFakeManageUsers();
    const client = createFakeClient();

    const first = await applyDemoPlan({
      client,
      cognito,
      manageUsers,
      planPath: planToPath(plan),
      env: 'test',
      endpoint: DEV_API,
      outputs: { auth: { user_pool_id: 'test-pool' } },
    });
    expect(first.created).toBe(6);

    const second = await applyDemoPlan({
      client,
      cognito,
      manageUsers,
      planPath: planToPath(plan),
      env: 'test',
      endpoint: DEV_API,
      outputs: { auth: { user_pool_id: 'test-pool' } },
    });
    expect(second.created).toBe(0);
    expect(second.staff.every((s) => s.created === 0)).toBe(true);
  });

  it('calls RESET_DEMO_DATA first when the plan carries reset', async () => {
    const plan = buildDemoPlan({ env: 'test', endpoint: DEV_API, reset: true });
    const client = createFakeClient();
    await applyDemoPlan({
      client,
      cognito: createFakeCognito(),
      manageUsers: createFakeManageUsers(),
      planPath: planToPath(plan),
      env: 'test',
      endpoint: DEV_API,
      outputs: { auth: { user_pool_id: 'test-pool' } },
    });

    expect(client.tmsShipmentActions).toHaveBeenCalledTimes(2);
    expect(client.tmsShipmentActions.mock.calls[0]).toEqual(['RESET_DEMO_DATA', {}]);
    expect(client.tmsShipmentActions.mock.calls[1][0]).toBe('SEED_DEMO_DATA');
  });

  it('removes demo staff in remove-staff mode', async () => {
    const plan = buildDemoPlan({ env: 'test', endpoint: DEV_API, removeStaff: true });
    const manageUsers = createFakeManageUsers();
    const report = await applyDemoPlan({
      client: createFakeClient(),
      cognito: createFakeCognito(),
      manageUsers,
      planPath: planToPath(plan),
      env: 'test',
      endpoint: DEV_API,
      outputs: { auth: { user_pool_id: 'test-pool' } },
    });

    expect(report.removeStaff).toBe(true);
    expect(report.removed).toBe(6);
    expect(manageUsers).toHaveBeenCalledTimes(6);
    for (const member of DEMO_STAFF) {
      expect(manageUsers).toHaveBeenCalledWith('delete', { username: member.email });
    }
  });
});
