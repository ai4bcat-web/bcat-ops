import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryClient } from './lib/tmsClient.mjs';
import {
  readSeedInput,
  validateDivisionRow,
  buildDivisionPlan,
  applyDivisionPlan,
} from './seedDivisions.mjs';
import { savePlan } from './lib/tmsPlan.mjs';

describe('seedDivisions planning', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-seed-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function inputPath(content) {
    const path = join(tmpDir, 'input.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('validates required division fields and skips unknowns', () => {
    expect(validateDivisionRow({}, 0).valid).toBe(false);
    expect(validateDivisionRow({ key: 'X', name: 'X', active: true }, 0).valid).toBe(true);
    expect(validateDivisionRow({ key: 'unknown', name: 'X', active: true }, 0).valid).toBe(false);
    expect(validateDivisionRow({ key: 'X', name: 'X', active: true, fleetGroup: 'TRAIN' }, 0).valid).toBe(false);
  });

  it('does not auto-fill missing division fields', () => {
    const { valid, cleaned } = validateDivisionRow({ key: 'BC', name: 'BCAT', active: true }, 0);
    expect(valid).toBe(true);
    expect(cleaned.fleetGroup).toBeUndefined();
  });

  it('reads operator-reviewed JSON and builds a plan', async () => {
    const path = inputPath({
      divisions: [
        { key: 'IVAN_CARTAGE', name: 'Ivan Cartage', active: true, fleetGroup: 'LOCAL', invoicePrefix: 'IV' },
        { key: 'AMAZON_DSP', name: 'Amazon DSP', active: true },
      ],
      settings: { marginFloorBps: 500 },
    });
    const plan = buildDivisionPlan({ inputPath: path, env: 'test', endpoint: 'memory://' });
    expect(plan.actions).toHaveLength(3); // 2 divisions + settings
    const div1 = plan.actions.find((a) => a.divisionKey === 'IVAN_CARTAGE');
    expect(div1.input.fleetGroup).toBe('LOCAL');
    expect(plan.actions.find((a) => a.action === 'SAVE_SETTINGS')).toBeTruthy();
  });

  it('reports empty seed when no valid divisions remain', () => {
    const path = inputPath({ divisions: [{ key: 'unknown', name: 'X', active: true }] });
    const plan = buildDivisionPlan({ inputPath: path, env: 'test', endpoint: 'memory://' });
    expect(plan.reviewables[0].kind).toBe('EMPTY_SEED');
    expect(plan.actions).toHaveLength(0);
  });
});

describe('seedDivisions apply boundary', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-seed-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function withInput(content) {
    const path = join(tmpDir, 'input.json');
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  function planToPath(plan) {
    const path = join(tmpDir, 'plan.json');
    savePlan(plan, path);
    return path;
  }

  it('applies divisions deterministically by key', async () => {
    const input = withInput({ divisions: [{ key: 'IVAN_CARTAGE', name: 'Ivan Cartage', active: true }] });
    const plan = buildDivisionPlan({ inputPath: input, env: 'test', endpoint: 'memory://' });
    const client = createMemoryClient();
    const report = await applyDivisionPlan({ client, planPath: planToPath(plan), inputPath: input, env: 'test', endpoint: 'memory://' });
    expect(report.applied).toBe(1);
    expect(client._data.divisions.get('IVAN_CARTAGE').name).toBe('Ivan Cartage');
  });

  it('blocks apply to production', async () => {
    const { detectMode } = await import('./lib/tmsConfig.mjs');
    expect(() => detectMode(true, 'prod')).toThrow('blocked');
  });
});
