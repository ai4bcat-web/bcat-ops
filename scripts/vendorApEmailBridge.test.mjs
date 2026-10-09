import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsCode = readFileSync(resolve(__dirname, 'vendorApEmailBridge.gs'), 'utf8');

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

function makeAttachment(overrides = {}) {
  const blob = { bytes: overrides.content || 'blob-content' };
  return {
    name: overrides.name ?? 'invoice.pdf',
    contentType: overrides.contentType ?? 'application/pdf',
    size: overrides.size ?? 12345,
    disposition: overrides.disposition ?? 'attachment',
    getName() { return this.name; },
    getContentType() { return this.contentType; },
    getSize() { return this.size; },
    getContentDisposition() { return this.disposition; },
    copyBlob() { return blob; },
  };
}

function makeBridge({
  properties = {},
  responses = [],
  s3Responses = [],
  messages = [],
  globals = {},
  fakeDate = Date,
} = {}) {
  const state = {
    properties: {
      VENDOR_AP_WEBHOOK_URL: 'https://example.com/vendor-ap',
      VENDOR_AP_WEBHOOK_SECRET: 'secret',
      ...properties,
    },
    labels: {},
    triggers: [],
    fetched: [],
    responses: responses.length ? responses : [makePrepareResponse()],
    responseIndex: 0,
    s3Responses: s3Responses.length ? s3Responses : [{ code: 200, body: '' }],
    s3ResponseIndex: 0,
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

  const byThread = new Map();
  messages.forEach((m) => {
    const key = m.threadId ?? m.id;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(m);
  });
  const allThreads = [];
  byThread.forEach((msgs) => allThreads.push(makeThread(msgs)));
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
        let parsedPayload = null;
        if (opts.payload && typeof opts.payload === 'string') {
          try { parsedPayload = JSON.parse(opts.payload); } catch (e) { parsedPayload = null; }
        } else if (opts.payload) {
          parsedPayload = opts.payload;
        }
        state.fetched.push({ url, payload: parsedPayload, opts });

        const isWebhook = url === state.properties.VENDOR_AP_WEBHOOK_URL;
        let r;
        if (isWebhook) {
          r = state.responses[state.responseIndex];
          state.responseIndex = (state.responseIndex + 1) % state.responses.length;
        } else {
          r = state.s3Responses[state.s3ResponseIndex];
          state.s3ResponseIndex = (state.s3ResponseIndex + 1) % state.s3Responses.length;
        }
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

  const plainBody = overrides.plainBody ?? 'Please pay this invoice.';

  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    threadId: overrides.threadId,
    to: overrides.to ?? 'vendorpayments@bcatcorp.com',
    cc: overrides.cc ?? '',
    headers,
    subject: overrides.subject ?? 'Invoice #12345',
    from: overrides.from ?? 'vendor@example.com',
    date: overrides.date ?? new Date('2026-09-23T12:00:00Z'),
    attachments: overrides.attachments ?? [makeAttachment()],
    getId() { return this.id; },
    getTo() { return this.to; },
    getCc() { return this.cc; },
    getHeader(name) { return this.headers[name] || ''; },
    getSubject() { return this.subject; },
    getFrom() { return this.from; },
    getDate() { return this.date; },
    getPlainBody() { return plainBody; },
    getAttachments(opts) {
      // Gmail drops inline images when asked to; the bridge asks, because GmailAttachment
      // has no content-disposition accessor to filter on afterwards.
      const inline = opts && opts.includeInlineImages === false;
      return inline ? this.attachments.filter((a) => a.disposition !== 'inline') : this.attachments;
    },
    getThread() { return this._thread; },
  };
}

function makePrepareResponse(overrides = {}) {
  if (overrides.duplicate) {
    return { code: 200, body: JSON.stringify({ ok: true, duplicate: true, rowId: 'email:msg-123' }) };
  }
  const uploadUrls = overrides.uploadUrls ?? [
    { url: 'https://s3.amazonaws.com/upload/1', s3Key: 'intake-pdfs/vendor-ap/abc/0-invoice.pdf', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 },
  ];
  return { code: 200, body: JSON.stringify({ ok: true, duplicate: false, rowId: 'email:msg-123', uploadUrls }) };
}

function webhookCalls(state) {
  return state.fetched.filter((f) => f.url === state.properties.VENDOR_AP_WEBHOOK_URL);
}

function prepareCalls(state) {
  return webhookCalls(state).filter((f) => f.payload && f.payload.action === 'prepare');
}

function makeCommitResponse(overrides = {}) {
  return { code: 200, body: JSON.stringify({ ok: true, duplicate: overrides.duplicate ?? false, rowId: 'email:msg-123' }) };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('vendorApEmailBridge.gs', () => {
  it('processes a new message with attachments and acks it', () => {
    const attachments = [makeAttachment({ name: 'invoice.pdf' }), makeAttachment({ name: 'receipt.png', contentType: 'image/png' })];
    const m = makeMessage({ id: 'm1', attachments });
    const uploadUrls = [
      { url: 'https://s3.amazonaws.com/upload/1', s3Key: 'k1', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 },
      { url: 'https://s3.amazonaws.com/upload/2', s3Key: 'k2', name: 'receipt.png', contentType: 'image/png', size: 67890 },
    ];
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse({ uploadUrls }), makeCommitResponse()],
    });

    ctx.processVendorApEmails();

    expect(state.fetched).toHaveLength(4);
    expect(state.fetched[0].payload.action).toBe('prepare');
    expect(state.fetched[0].payload.messageId).toBe('m1');
    expect(state.fetched[0].payload.attachments).toHaveLength(2);
    expect(state.fetched[0].payload.attachments[0]).toMatchObject({ name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 });

    expect(state.fetched[1].url).toBe('https://s3.amazonaws.com/upload/1');
    expect(state.fetched[1].opts.method).toBe('put');

    const commit = state.fetched[3].payload;
    expect(commit.action).toBe('commit');
    expect(commit.attachments).toHaveLength(2);
    expect(commit.attachments[0]).toMatchObject({ s3Key: 'k1', name: 'invoice.pdf', contentType: 'application/pdf', size: 12345 });

    expect(state.properties['vendorap:msg:m1']).toMatch(/^ok:/);
  });

  it('acks a duplicate without uploading attachments', () => {
    const m = makeMessage({ id: 'm2' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse({ duplicate: true })],
    });

    ctx.processVendorApEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.properties['vendorap:msg:m2']).toMatch(/^ok:/);
  });

  it('labels 422 prepare responses and acks them', () => {
    const m = makeMessage({ id: 'm3' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 422, body: JSON.stringify({ error: 'bad payload' }) }],
    });

    ctx.processVendorApEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.properties['vendorap:msg:m3']).toMatch(/^reviewed:/);
    expect(m.getThread()._labels.map((l) => l.getName())).toContain('vendor-ap-needs-review');
  });

  it('does not ack on 5xx prepare responses so they are retried', () => {
    const m = makeMessage({ id: 'm4' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 500, body: 'boom' }],
    });

    expect(() => ctx.processVendorApEmails()).toThrow();
    expect(state.properties['vendorap:msg:m4']).toBeUndefined();
  });

  it('labels 422 commit responses and acks them after uploads', () => {
    const m = makeMessage({ id: 'm5' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse(), { code: 422, body: JSON.stringify({ error: 'size mismatch' }) }],
    });

    ctx.processVendorApEmails();

    expect(state.fetched).toHaveLength(3);
    expect(state.properties['vendorap:msg:m5']).toMatch(/^reviewed:/);
  });

  it('does not ack when an S3 upload fails', () => {
    const m = makeMessage({ id: 'm6' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse()],
      s3Responses: [{ code: 500, body: 's3 error' }],
    });

    expect(() => ctx.processVendorApEmails()).toThrow();
    expect(state.properties['vendorap:msg:m6']).toBeUndefined();
  });

  it('does not ack when commit returns 5xx', () => {
    const m = makeMessage({ id: 'm7' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse(), { code: 500, body: 'boom' }],
    });

    expect(() => ctx.processVendorApEmails()).toThrow();
    expect(state.properties['vendorap:msg:m7']).toBeUndefined();
  });

  it('skips messages that are not addressed to the vendor AP recipient', () => {
    const m = makeMessage({ id: 'm8', to: 'other@example.com', cc: '' });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processVendorApEmails();

    expect(state.fetched).toHaveLength(0);
    expect(state.properties['vendorap:msg:m8']).toBeUndefined();
  });

  it('skips already-acked messages and processes a new message in the same thread', () => {
    const m1 = makeMessage({ id: 'm1', threadId: 't1' });
    const m2 = makeMessage({ id: 'm2', threadId: 't1' });
    const { ctx, state } = makeBridge({
      properties: { 'vendorap:msg:m1': 'ok:2026-01-01T00:00:00Z' },
      messages: [m1, m2],
    });

    ctx.processVendorApEmails();

    const calls = prepareCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.messageId).toBe('m2');
    expect(state.properties['vendorap:msg:m2']).toMatch(/^ok:/);
  });

  it('processes forwarded mail matched via X-Original-To', () => {
    const m = makeMessage({
      id: 'fwd1',
      to: 'ai4bcat@gmail.com',
      xOriginalTo: 'vendorpayments@bcatcorp.com',
    });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processVendorApEmails();

    const calls = prepareCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.messageId).toBe('fwd1');
  });

  it('processes list mail matched via List-ID header', () => {
    const m = makeMessage({
      id: 'list1',
      to: 'ai4bcat@gmail.com',
      listId: '<vendorpayments.bcatcorp.com>',
    });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processVendorApEmails();

    const calls = prepareCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.messageId).toBe('list1');
  });

  it('excludes inline attachments from upload', () => {
    const attachments = [
      makeAttachment({ name: 'invoice.pdf', disposition: 'attachment' }),
      makeAttachment({ name: 'logo.png', disposition: 'inline' }),
    ];
    const m = makeMessage({ id: 'inline1', attachments });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse(), makeCommitResponse()],
    });

    ctx.processVendorApEmails();

    expect(state.fetched[0].payload.attachments).toHaveLength(1);
    expect(state.fetched[0].payload.attachments[0].name).toBe('invoice.pdf');
    expect(state.fetched[2].payload.attachments).toHaveLength(1);
  });

  it('truncates long plain bodies and preserves a truncation indicator', () => {
    const longBody = 'x'.repeat(60_000);
    const m = makeMessage({ id: 'long1', plainBody: longBody });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processVendorApEmails();

    const sentBody = state.fetched[0].payload.emailBody;
    expect(sentBody.length).toBeLessThanOrEqual(50_000);
    expect(sentBody.endsWith('[truncated]')).toBe(true);
  });

  it('search query covers all recipient headers and excludes trash/spam', () => {
    const m = makeMessage({ id: 'q1' });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processVendorApEmails();

    const query = state.searchCalls[0].query;
    expect(query).toContain('to:vendorpayments@bcatcorp.com');
    expect(query).toContain('cc:vendorpayments@bcatcorp.com');
    expect(query).toContain('deliveredto:vendorpayments@bcatcorp.com');
    expect(query).toContain('list:vendorpayments.bcatcorp.com');
    expect(query).toContain('"vendorpayments@bcatcorp.com"');
    expect(query).toContain('-in:trash -in:spam');
    expect(query).not.toContain('is:unread');
  });

  it('sweeps unacknowledged older mail even when newest pages are already processed', () => {
    const messages = Array.from({ length: 80 }, (_, i) => makeMessage({ id: 'backlog' + i }));
    const acked = Object.fromEntries(messages.slice(1).map((m) => ['vendorap:msg:' + m.id, 'ok']));
    const { ctx, state } = makeBridge({ messages, properties: acked });
    for (let run = 0; run < 5; run++) ctx.processVendorApEmails();
    expect(prepareCalls(state).map((f) => f.payload.messageId)).toEqual(['backlog0']);
  });

  it('imports a multi-page burst while the durable cursor is deep in old backlog', () => {
    const oldMsgs = [];
    for (let i = 1; i <= 60; i++) {
      oldMsgs.push(makeMessage({ id: `old${i}`, subject: `Invoice #${i}` }));
    }
    const newMsgs = [];
    for (let i = 1; i <= 35; i++) {
      newMsgs.push(makeMessage({ id: `new${i}`, subject: `Invoice #${1000 + i}` }));
    }
    const acked = {};
    for (let i = 1; i <= 60; i++) {
      acked[`vendorap:msg:old${i}`] = 'ok:2026-01-01T00:00:00Z';
    }

    const { ctx, state } = makeBridge({
      messages: [...oldMsgs, ...newMsgs],
      properties: { ...acked, 'vendorap:cursor': '60' },
    });

    ctx.processVendorApEmails();

    const calls = prepareCalls(state);
    const newPosted = calls.filter((f) => f.payload.messageId?.startsWith('new'));
    const oldPosted = calls.filter((f) => f.payload.messageId?.startsWith('old'));
    expect(newPosted.map((f) => f.payload.messageId).sort()).toEqual(newMsgs.map((m) => m.id).sort());
    expect(oldPosted).toHaveLength(0);
  });

  it('resumes the unfinished page after a deadline without skipping invoices', () => {
    const messages = [];
    for (let i = 1; i <= 60; i++) {
      messages.push(makeMessage({ id: `dl${i}` }));
    }
    const fakeDate = makeFakeDate(0, 10_000);
    const { ctx, state } = makeBridge({ messages, fakeDate });

    ctx.processVendorApEmails();

    const sent = new Set(prepareCalls(state).map((f) => f.payload.messageId));
    const nextUnsent = [...messages].reverse().find((m) => !sent.has(m.id));
    expect(nextUnsent).toBeDefined();

    const resumed = makeBridge({ messages, properties: state.properties });
    resumed.ctx.processVendorApEmails();
    expect(prepareCalls(resumed.state).map((f) => f.payload.messageId)).toContain(nextUnsent.id);

    resumed.ctx.processVendorApEmails();
    const allSent = [...prepareCalls(state), ...prepareCalls(resumed.state)].map((f) => f.payload.messageId).sort();
    expect(allSent).toEqual(messages.map((m) => m.id).sort());
  });

  it('setup creates label and trigger only once', () => {
    const { ctx, state } = makeBridge({
      properties: {
        VENDOR_AP_WEBHOOK_URL: 'https://example.com/vendor-ap',
        VENDOR_AP_WEBHOOK_SECRET: 'secret',
      },
    });

    ctx.setupVendorApEmailBridge();
    expect(Object.keys(state.labels)).toContain('vendor-ap-needs-review');
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0].handlerFunction).toBe('processVendorApEmails');
    expect(state.triggers[0].minutes).toBe(5);

    ctx.setupVendorApEmailBridge();
    expect(state.triggers).toHaveLength(1);
  });

  it('falls back to WEBHOOK_SECRET constant when VENDOR_AP_WEBHOOK_SECRET is absent', () => {
    const { ctx, state } = makeBridge({
      properties: {
        VENDOR_AP_WEBHOOK_URL: 'https://example.com/vendor-ap',
        VENDOR_AP_WEBHOOK_SECRET: '',
      },
      messages: [makeMessage({ id: 'fb1' })],
      globals: { WEBHOOK_SECRET: 'fallback-secret' },
    });
    ctx.processVendorApEmails();
    expect(state.fetched[0].payload.secret).toBe('fallback-secret');
  });
});
