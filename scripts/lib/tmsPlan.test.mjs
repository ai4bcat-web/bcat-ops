import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFingerprint,
  createPlan,
  loadPlan,
  savePlan,
  validatePlan,
  summarize,
} from './tmsPlan.mjs';

const ENDPOINT = 'https://test.example.com/graphql';

describe('tmsPlan', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-plan-'));
  });
  afterEach(() => {
    // Node runtime cleans up temp dir usage only; directory deletion omitted for speed.
  });

  it('creates deterministic fingerprints', () => {
    const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    expect(createFingerprint(rows)).toBe(createFingerprint([...rows].reverse()));
    expect(createFingerprint(rows)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('round-trips a plan file', () => {
    const plan = createPlan({
      environment: 'test',
      endpoint: ENDPOINT,
      sourceType: 'test',
      sourceRows: [{ key: 'x' }],
      actions: [{ action: 'UPSERT_CUSTOMER', input: {} }],
    });
    const path = join(tmpDir, 'plan.json');
    savePlan(plan, path);
    const loaded = loadPlan(path);
    expect(loaded.fingerprint).toBe(plan.fingerprint);
    expect(loaded.environment).toBe('test');
    expect(loaded.endpoint).toBe(ENDPOINT);
  });

  it('validates environment, endpoint, and fingerprint', () => {
    const plan = createPlan({
      environment: 'test',
      endpoint: ENDPOINT,
      sourceType: 'test',
      sourceRows: [{ key: 'x' }],
      actions: [],
    });
    validatePlan(plan, {
      environment: 'test',
      endpoint: ENDPOINT,
      sourceRows: [{ key: 'x' }],
    });
    expect(() =>
      validatePlan(plan, { environment: 'prod', endpoint: ENDPOINT, sourceRows: [{ key: 'x' }] })
    ).toThrow('environment mismatch');
    expect(() =>
      validatePlan(plan, {
        environment: 'test',
        endpoint: 'https://other.example.com/graphql',
        sourceRows: [{ key: 'x' }],
      })
    ).toThrow('endpoint mismatch');
    expect(() =>
      validatePlan(plan, { environment: 'test', endpoint: ENDPOINT, sourceRows: [{ key: 'y' }] })
    ).toThrow('fingerprint mismatch');
  });

  it('summarises a plan', () => {
    const plan = createPlan({
      environment: 'test',
      endpoint: ENDPOINT,
      sourceType: 'test',
      sourceRows: [{ key: 'x' }],
      actions: [{ action: 'UPSERT_CUSTOMER', input: {} }],
      reviewables: [{ kind: 'X' }],
      unresolved: [{ key: 'y' }],
    });
    expect(summarize(plan)).toMatch(/Source rows:\s+1/);
    expect(summarize(plan)).toMatch(/Actions:\s+1/);
    expect(summarize(plan)).toMatch(/Reviewables:\s+1/);
    expect(summarize(plan)).toMatch(/Unresolved:\s+1/);
  });
});
