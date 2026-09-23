import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsCode = readFileSync(resolve(__dirname, 'factoringEmailBridge.gs'), 'utf8');

// ── Test harness ─────────────────────────────────────────────────────────────

function loadScript(env = {}) {
  const context = vm.createContext({
    console,
    URL: globalThis.URL,
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Math,
    parseInt,
    isNaN,
    Error,
    ...env,
  });
  vm.runInContext(gsCode, context);
  return context;
}

function makeFakeDate(startMs, incrementMs = 0) {
  let current = startMs;
  return class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [current]));
    }
    static now() {
      const result = current;
      current += incrementMs;
      return result;
    }
  };
}

function makeBridge({ properties = {}, responses = [], messages = [], globals = {}, fakeDate = Date } = {}) {
  const state = {
    properties: {
      FACTORING_WEBHOOK_URL: 'https://example.com/factoring',
      FACTORING_WEBHOOK_SECRET: 'secret',
      ...properties,
    },
    labels: {},
    triggers: [],
    fetched: [],
    responses: responses.length ? responses : [{ code: 200, body: JSON.stringify({ ok: true, proNumber: '12345' }) }],
    responseIndex: 0,
    lockHeld: false,
    searchCalls: [],
  };

  function makeLabel(name) {
    const label = {
      name,
      getName: () => name,
    };
    state.labels[name] = label;
    return label;
  }

  function makeThread(msgs) {
    const labels = [];
    const thread = {
      getMessages: () => msgs,
      addLabel: (label) => labels.push(label),
      _labels: labels,
    };
    msgs.forEach((m) => {
      m._thread = thread;
    });
    return thread;
  }

  // Group messages by threadId; default each to its own thread.
  const byThread = new Map();
  messages.forEach((m) => {
    const key = m.threadId ?? m.id;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(m);
  });
  const allThreads = [];
  byThread.forEach((msgs) => allThreads.push(makeThread(msgs)));
  // Newest first, matching GmailApp.search ordering.
  allThreads.reverse();

  const mocks = {
    GmailApp: {
      getUserLabelByName: (name) => state.labels[name] || null,
      createLabel: (name) => makeLabel(name),
      search: (query, start, max) => {
        state.searchCalls.push({ query, start, max });
        return allThreads.slice(start, start + max);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in state.properties ? state.properties[key] : null),
        setProperty: (key, value) => {
          state.properties[key] = String(value);
        },
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        state.fetched.push({ url, payload: JSON.parse(opts.payload) });
        const r = state.responses[state.responseIndex];
        state.responseIndex = (state.responseIndex + 1) % state.responses.length;
        return {
          getResponseCode: () => r.code,
          getContentText: () => r.body,
        };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers,
      newTrigger: (fnName) => ({
        timeBased: () => ({
          everyMinutes: (mins) => ({
            create: () => {
              const trigger = {
                handlerFunction: fnName,
                minutes: mins,
                getHandlerFunction: () => fnName,
              };
              state.triggers.push(trigger);
            },
          }),
        }),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: (ms) => {
          if (state.lockHeld) return false;
          state.lockHeld = true;
          return true;
        },
        releaseLock: () => {
          state.lockHeld = false;
        },
      }),
    },
  };

  const ctx = loadScript({ ...mocks, ...globals, Date: fakeDate });
  return { ctx, state };
}

function makeMessage(overrides = {}) {
  const headers = {};
  if (overrides.deliveredTo !== undefined) headers['Delivered-To'] = overrides.deliveredTo;
  if (overrides.xOriginalTo !== undefined) headers['X-Original-To'] = overrides.xOriginalTo;
  if (overrides.listId !== undefined) headers['List-ID'] = overrides.listId;

  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    threadId: overrides.threadId,
    to: overrides.to ?? 'factor@bcatcorp.com',
    cc: overrides.cc ?? '',
    headers,
    subject: overrides.subject ?? 'Invoice for PRO #12345',
    from: overrides.from ?? 'broker@example.com',
    date: overrides.date ?? new Date('2026-09-23T12:00:00Z'),
    getId() { return this.id; },
    getTo() { return this.to; },
    getCc() { return this.cc; },
    getHeader(name) { return this.headers[name] || ''; },
    getSubject() { return this.subject; },
    getFrom() { return this.from; },
    getDate() { return this.date; },
    getThread() { return this._thread; },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('factoringEmailBridge.gs', () => {
  it('processes a new message and marks it acked', () => {
    const m = makeMessage({ id: 'm1' });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processFactoringEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0].payload.messageId).toBe('m1');
    expect(state.properties['factoring:msg:m1']).toMatch(/^ok:/);
    expect(state.searchCalls[0].query).toContain('to:factor@bcatcorp.com');
    expect(state.searchCalls[0].query).toContain('list:factor.bcatcorp.com');
    expect(state.searchCalls[0].query).toContain('-in:trash -in:spam');
  });

  it('skips already-acked messages and processes a new message in the same thread', () => {
    const m1 = makeMessage({ id: 'm1', threadId: 't1' });
    const m2 = makeMessage({ id: 'm2', threadId: 't1' });
    const { ctx, state } = makeBridge({
      properties: { 'factoring:msg:m1': 'ok:2026-01-01T00:00:00Z' },
      messages: [m1, m2],
    });

    ctx.processFactoringEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0].payload.messageId).toBe('m2');
    expect(state.properties['factoring:msg:m2']).toMatch(/^ok:/);
  });

  it('processes forwarded mail matched via X-Original-To', () => {
    const m = makeMessage({
      id: 'fwd1',
      to: 'ai4bcat@gmail.com',
      xOriginalTo: 'factor@bcatcorp.com',
      subject: 'Invoice for PRO #99999',
    });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processFactoringEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0].payload.messageId).toBe('fwd1');
    expect(state.properties['factoring:msg:fwd1']).toMatch(/^ok:/);
  });

  it('processes list mail matched via List-ID header', () => {
    const m = makeMessage({
      id: 'list1',
      to: 'ai4bcat@gmail.com',
      listId: '<factor.bcatcorp.com>',
      subject: 'Invoice for PRO #55555',
    });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processFactoringEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0].payload.messageId).toBe('list1');
    expect(state.properties['factoring:msg:list1']).toMatch(/^ok:/);
  });

  it('labels 422-rejected subjects and does not retry', () => {
    const m = makeMessage({ id: 'bad1', subject: 'Random subject' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 422, body: JSON.stringify({ error: 'no invoice PRO number' }) }],
    });

    ctx.processFactoringEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0].payload.messageId).toBe('bad1');
    expect(state.properties['factoring:msg:bad1']).toMatch(/^reviewed:/);
    expect(m.getThread()._labels.map((l) => l.getName())).toContain('factoring-needs-review');
  });

  it('does not mark processed on 400 bad payload so it is retried', () => {
    const m = makeMessage({ id: 'badpayload1', subject: 'Invoice for PRO #33333' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 400, body: JSON.stringify({ error: 'messageId required' }) }],
    });

    expect(() => ctx.processFactoringEmails()).toThrow();
    expect(state.properties['factoring:msg:badpayload1']).toBeUndefined();
    expect(state.fetched).toHaveLength(1);
  });

  it('does not mark processed on 5xx so the message is retried', () => {
    const m = makeMessage({ id: 'err1', subject: 'Invoice for PRO #11111' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 500, body: 'boom' }],
    });

    expect(() => ctx.processFactoringEmails()).toThrow();
    expect(state.properties['factoring:msg:err1']).toBeUndefined();
    expect(state.fetched).toHaveLength(1);
  });

  it('does not mark processed on 401 wrong secret', () => {
    const m = makeMessage({ id: 'auth1', subject: 'Invoice for PRO #22222' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 401, body: JSON.stringify({ error: 'unauthorized' }) }],
    });

    expect(() => ctx.processFactoringEmails()).toThrow();
    expect(state.properties['factoring:msg:auth1']).toBeUndefined();
  });

  it('sweeps unacknowledged older mail even when the newest pages are already processed', () => {
    const messages = Array.from({ length: 80 }, (_, i) => makeMessage({ id: 'backlog' + i }));
    const acked = Object.fromEntries(messages.slice(1).map((m) => ['factoring:msg:' + m.id, 'ok']));
    const { ctx, state } = makeBridge({ messages, properties: acked });
    for (let run = 0; run < 5; run++) ctx.processFactoringEmails();
    expect(state.fetched.map((f) => f.payload.messageId)).toEqual(['backlog0']);
  });

  it('imports a multi-page burst while the durable cursor is deep in old backlog', () => {
    // More new threads than fit on the first page must arrive in the same run.
    const oldMsgs = [];
    for (let i = 1; i <= 60; i++) {
      oldMsgs.push(makeMessage({ id: `old${i}`, subject: `Invoice for PRO #${i}` }));
    }
    const newMsgs = [];
    for (let i = 1; i <= 35; i++) {
      newMsgs.push(makeMessage({ id: `new${i}`, subject: `Invoice for PRO #${1000 + i}` }));
    }
    const acked = {};
    for (let i = 1; i <= 60; i++) {
      acked[`factoring:msg:old${i}`] = 'ok:2026-01-01T00:00:00Z';
    }

    const { ctx, state } = makeBridge({
      messages: [...oldMsgs, ...newMsgs],
      properties: { ...acked, 'factoring:cursor': '60' },
    });

    ctx.processFactoringEmails();

    const newPosted = state.fetched.filter((f) => f.payload.messageId.startsWith('new'));
    const oldPosted = state.fetched.filter((f) => f.payload.messageId.startsWith('old'));
    expect(newPosted.map((f) => f.payload.messageId).sort()).toEqual(newMsgs.map((m) => m.id).sort());
    expect(oldPosted).toHaveLength(0);
  });


  it('resumes the unfinished page after a deadline without skipping invoices', () => {
    const messages = [];
    for (let i = 1; i <= 60; i++) {
      messages.push(makeMessage({ id: `dl${i}`, subject: `Invoice for PRO #${i}` }));
    }
    const fakeDate = makeFakeDate(0, 10_000);
    const { ctx, state } = makeBridge({ messages, fakeDate });

    ctx.processFactoringEmails();

    const sent = new Set(state.fetched.map((f) => f.payload.messageId));
    const nextUnsent = [...messages].reverse().find((m) => !sent.has(m.id));
    expect(nextUnsent).toBeDefined();
    const resumed = makeBridge({ messages, properties: state.properties });
    resumed.ctx.processFactoringEmails();
    expect(resumed.state.fetched.map((f) => f.payload.messageId)).toContain(nextUnsent.id);
    resumed.ctx.processFactoringEmails();
    const allSent = [...state.fetched, ...resumed.state.fetched].map((f) => f.payload.messageId).sort();
    expect(allSent).toEqual(messages.map((m) => m.id).sort());
  });

  it('setup creates label and trigger only once', () => {
    const { ctx, state } = makeBridge({
      properties: {
        FACTORING_WEBHOOK_URL: 'https://example.com/factoring',
        FACTORING_WEBHOOK_SECRET: 'secret',
      },
    });

    ctx.setupFactoringEmailBridge();
    expect(Object.keys(state.labels)).toContain('factoring-needs-review');
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0].handlerFunction).toBe('processFactoringEmails');
    expect(state.triggers[0].minutes).toBe(5);

    ctx.setupFactoringEmailBridge();
    expect(state.triggers).toHaveLength(1); // idempotent
  });

  it('falls back to WEBHOOK_SECRET constant when FACTORING_WEBHOOK_SECRET is absent', () => {
    const { ctx, state } = makeBridge({
      properties: {
        FACTORING_WEBHOOK_URL: 'https://example.com/factoring',
        FACTORING_WEBHOOK_SECRET: '',
      },
      messages: [makeMessage({ id: 'fb1' })],
      globals: { WEBHOOK_SECRET: 'fallback-secret' },
    });
    ctx.processFactoringEmails();
    expect(state.fetched[0].payload.secret).toBe('fallback-secret');
  });
});
