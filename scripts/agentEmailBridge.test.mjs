import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsCode = readFileSync(resolve(__dirname, 'agentEmailBridge.gs'), 'utf8');

const WEBHOOK_URL = 'https://example.com/workflow-agent';

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

function makeAttachment(overrides = {}) {
  const blob = { bytes: overrides.content || 'blob-content' };
  return {
    name: overrides.name ?? 'quote-request.pdf',
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
} = {}) {
  const state = {
    properties: {
      WORKFLOW_AGENT_URL: WEBHOOK_URL,
      WORKFLOW_AGENT_SECRET: 'secret',
      ...properties,
    },
    labels: {},
    triggers: [],
    fetched: [],
    responses: responses.length ? responses : [makePrepareResponse(), makeCommitResponse()],
    responseIndex: 0,
    s3Responses: s3Responses.length ? s3Responses : [{ code: 200, body: '' }],
    s3ResponseIndex: 0,
    lockHeld: false,
    searchCalls: [],
  };

  function makeLabel(name) {
    const label = { name, getName: () => name };
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

        const isWebhook = url === state.properties.WORKFLOW_AGENT_URL;
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
              state.triggers.push({
                handlerFunction: fnName,
                minutes: mins,
                getHandlerFunction: () => fnName,
              });
            },
          }),
        }),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
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

  const ctx = loadScript({ ...mocks, ...globals });
  return { ctx, state };
}

function makeMessage(overrides = {}) {
  const headers = {};
  if (overrides.deliveredTo !== undefined) headers['Delivered-To'] = overrides.deliveredTo;
  if (overrides.xOriginalTo !== undefined) headers['X-Original-To'] = overrides.xOriginalTo;
  if (overrides.listId !== undefined) headers['List-ID'] = overrides.listId;

  const plainBody = overrides.plainBody ?? 'What would you charge Chicago to Dallas?';
  // Gmail hands the bridge the whole RFC 822 message; the bridge reads the verdict out
  // of its header block. `rawContent: null` is a message whose raw fetch failed.
  const rawContent = overrides.rawContent !== undefined
    ? overrides.rawContent
    : [
      'Delivered-To: quotes@bcatcorp.com',
      ...(overrides.authResult === undefined ? [] : [`Authentication-Results: ${overrides.authResult}`]),
      'Subject: ' + (overrides.subject ?? 'Rate request CHI -> DAL'),
      '',
      plainBody,
    ].join('\r\n');

  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    threadId: overrides.threadId,
    to: overrides.to ?? 'quotes@bcatcorp.com',
    cc: overrides.cc ?? '',
    headers,
    subject: overrides.subject ?? 'Rate request CHI -> DAL',
    from: overrides.from ?? '"Dispatch Team" <dispatch@batory.com>',
    date: overrides.date ?? new Date('2026-10-20T12:00:00Z'),
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
      const inline = opts && opts.includeInlineImages === false;
      return inline ? this.attachments.filter((a) => a.disposition !== 'inline') : this.attachments;
    },
    getRawContent() {
      if (rawContent === null) throw new Error('raw fetch failed');
      return rawContent;
    },
    getThread() { return this._thread; },
  };
}

function makePrepareResponse(overrides = {}) {
  if (overrides.duplicate) {
    return { code: 200, body: JSON.stringify({ ok: true, duplicate: true, runId: 'wf:QUOTE:abc' }) };
  }
  const uploadUrls = overrides.uploadUrls ?? [
    { url: 'https://s3.amazonaws.com/upload/1', s3Key: 'workflow-inbox/abc/0-quote-request.pdf', name: 'quote-request.pdf', contentType: 'application/pdf', size: 12345 },
  ];
  return { code: 200, body: JSON.stringify({ ok: true, duplicate: false, runId: 'wf:QUOTE:abc', uploadUrls }) };
}

function makeCommitResponse(overrides = {}) {
  return { code: 200, body: JSON.stringify({ ok: true, duplicate: overrides.duplicate ?? false, runId: 'wf:QUOTE:abc' }) };
}

function webhookCalls(state) {
  return state.fetched.filter((f) => f.url === state.properties.WORKFLOW_AGENT_URL);
}

function prepareCalls(state) {
  return webhookCalls(state).filter((f) => f.payload && f.payload.action === 'prepare');
}

function commitCalls(state) {
  return webhookCalls(state).filter((f) => f.payload && f.payload.action === 'commit');
}

/** Only the QUOTE and TENDER groups exist; AP and CAPACITY are not provisioned. */
const TWO_ROLE_PROPERTIES = { AGENT_INBOX_AP: '', AGENT_INBOX_CAPACITY: '' };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('agentEmailBridge.gs', () => {
  it('resolves the role from the address a message was delivered to', () => {
    const m = makeMessage({ id: 'q1', to: 'quotes@bcatcorp.com' });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processAgentInboxEmails();

    const prepare = prepareCalls(state);
    expect(prepare).toHaveLength(1);
    expect(prepare[0].payload.role).toBe('QUOTE');
    expect(prepare[0].payload.messageId).toBe('q1');
    expect(prepare[0].payload.fromEmail).toBe('dispatch@batory.com');
    expect(prepare[0].payload.fromName).toBe('Dispatch Team');
    expect(prepare[0].payload.bodyText).toContain('Chicago to Dallas');
    expect(commitCalls(state)[0].payload.role).toBe('QUOTE');
    expect(state.properties['agentinbox:msg:q1']).toMatch(/^ok:/);
  });

  it('forwards the server’s own Authentication-Results verdict on both phases', () => {
    const m = makeMessage({
      id: 'q-auth',
      authResult: 'mx.google.com;\r\n       spf=pass (google.com: domain of dispatch@batory.com designates 1.2.3.4) smtp.mailfrom=dispatch@batory.com;\r\n       dkim=pass header.i=@batory.com',
    });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processAgentInboxEmails();

    const sent = prepareCalls(state)[0].payload.authResult;
    // Folded continuation lines are part of the same header, so the whole verdict has
    // to arrive — dkim=pass is on the third line.
    expect(sent).toContain('spf=pass');
    expect(sent).toContain('dkim=pass header.i=@batory.com');
    expect(sent).not.toContain('\n');
    // Both phases post the identical verdict; the commit is what gets stored.
    expect(commitCalls(state)[0].payload.authResult).toBe(sent);
  });

  it('sends an empty verdict, and still forwards the message, when there is none to read', () => {
    const none = makeMessage({ id: 'q-none', to: 'quotes@bcatcorp.com' });
    const unreadable = makeMessage({ id: 'q-raw-failed', to: 'quotes@bcatcorp.com', rawContent: null });
    const { ctx, state } = makeBridge({ messages: [none, unreadable] });

    ctx.processAgentInboxEmails();

    const byId = Object.fromEntries(prepareCalls(state).map((f) => [f.payload.messageId, f.payload.authResult]));
    expect(byId).toEqual({ 'q-none': '', 'q-raw-failed': '' });
    // A verdict that cannot be read is never a reason to drop the mail.
    expect(commitCalls(state).map((f) => f.payload.messageId).sort()).toEqual(['q-none', 'q-raw-failed']);
  });

  it('routes each configured address to its own role', () => {
    const messages = [
      makeMessage({ id: 'r-tender', to: 'tenders@bcatcorp.com' }),
      makeMessage({ id: 'r-ap', to: 'ops@bcatcorp.com', deliveredTo: 'carrierinvoices@bcatcorp.com' }),
      makeMessage({ id: 'r-capacity', to: 'ai4bcat@gmail.com', listId: '<trucks.bcatcorp.com>' }),
    ];
    const { ctx, state } = makeBridge({ messages });

    ctx.processAgentInboxEmails();

    const byId = Object.fromEntries(prepareCalls(state).map((f) => [f.payload.messageId, f.payload.role]));
    expect(byId).toEqual({ 'r-tender': 'TENDER', 'r-ap': 'AP', 'r-capacity': 'CAPACITY' });
  });

  it('skips a role whose address is blank and never searches for it', () => {
    const quote = makeMessage({ id: 'c1', to: 'quotes@bcatcorp.com' });
    const truck = makeMessage({ id: 'c2', to: 'trucks@bcatcorp.com' });
    const { ctx, state } = makeBridge({
      messages: [quote, truck],
      properties: { AGENT_INBOX_TENDER: '', AGENT_INBOX_AP: '', AGENT_INBOX_CAPACITY: '' },
    });

    ctx.processAgentInboxEmails();

    const query = state.searchCalls[0].query;
    expect(query).toContain('to:quotes@bcatcorp.com');
    expect(query).not.toContain('trucks@bcatcorp.com');
    expect(query).not.toContain('tenders@bcatcorp.com');
    expect(query).not.toContain('carrierinvoices@bcatcorp.com');

    expect(prepareCalls(state).map((f) => f.payload.messageId)).toEqual(['c1']);
    expect(state.properties['agentinbox:msg:c2']).toBeUndefined();
  });

  it('builds one parenthesised query covering both configured inboxes', () => {
    const { ctx, state } = makeBridge({
      messages: [makeMessage({ id: 'q2' })],
      properties: TWO_ROLE_PROPERTIES,
    });

    ctx.processAgentInboxEmails();

    expect(state.searchCalls[0].query).toBe(
      '(to:quotes@bcatcorp.com OR cc:quotes@bcatcorp.com OR deliveredto:quotes@bcatcorp.com'
      + ' OR list:quotes.bcatcorp.com OR "quotes@bcatcorp.com"'
      + ' OR to:tenders@bcatcorp.com OR cc:tenders@bcatcorp.com OR deliveredto:tenders@bcatcorp.com'
      + ' OR list:tenders.bcatcorp.com OR "tenders@bcatcorp.com") -in:trash -in:spam',
    );
  });

  it('honours an address override from script properties', () => {
    const m = makeMessage({ id: 'ov1', to: 'spotquotes@bcatgroup.com' });
    const { ctx, state } = makeBridge({
      messages: [m],
      properties: { AGENT_INBOX_QUOTE: 'spotquotes@bcatgroup.com' },
    });

    ctx.processAgentInboxEmails();

    const prepare = prepareCalls(state);
    expect(prepare).toHaveLength(1);
    expect(prepare[0].payload.role).toBe('QUOTE');
    expect(state.searchCalls[0].query).not.toContain('quotes@bcatcorp.com OR');
  });

  it('skips an oversized attachment, names it for review, and still posts the readable one', () => {
    const attachments = [
      makeAttachment({ name: 'rate-con.pdf', size: 1000 }),
      makeAttachment({ name: 'dashcam.pdf', size: 9 * 1024 * 1024 }),
    ];
    const m = makeMessage({ id: 'big1', attachments });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processAgentInboxEmails();

    const posted = prepareCalls(state)[0].payload.attachments;
    expect(posted.map((a) => a.name)).toEqual(['rate-con.pdf']);
    expect(m.getThread()._labels.map((l) => l.getName())).toContain('agent-inbox-needs-review');
    expect(state.properties['agentinbox:msg:big1']).toMatch(/^ok:/);
  });

  it('skips unsupported attachment types and caps attachments at three', () => {
    const attachments = [
      makeAttachment({ name: 'sheet.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      makeAttachment({ name: 'a.pdf' }),
      makeAttachment({ name: 'b.png', contentType: 'image/png' }),
      makeAttachment({ name: 'c.jpg', contentType: 'image/jpg' }),
      makeAttachment({ name: 'd.pdf' }),
    ];
    const m = makeMessage({ id: 'cap1', attachments });
    const uploadUrls = [0, 1, 2].map((i) => ({
      url: `https://s3.amazonaws.com/upload/${i}`,
      s3Key: `workflow-inbox/cap/${i}`,
      name: ['a.pdf', 'b.png', 'c.jpg'][i],
      contentType: ['application/pdf', 'image/png', 'image/jpeg'][i],
      size: 12345,
    }));
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse({ uploadUrls }), makeCommitResponse()],
    });

    ctx.processAgentInboxEmails();

    const posted = prepareCalls(state)[0].payload.attachments;
    expect(posted.map((a) => a.name)).toEqual(['a.pdf', 'b.png', 'c.jpg']);
    expect(posted.map((a) => a.contentType)).toEqual(['application/pdf', 'image/png', 'image/jpeg']);
    expect(m.getThread()._labels.map((l) => l.getName())).toContain('agent-inbox-needs-review');
  });

  it('commits the s3Keys prepare handed back, after uploading each one', () => {
    const attachments = [makeAttachment({ name: 'inv.pdf' }), makeAttachment({ name: 'bol.png', contentType: 'image/png', size: 2048 })];
    const m = makeMessage({ id: 'k1', to: 'carrierinvoices@bcatcorp.com', attachments });
    const uploadUrls = [
      { url: 'https://s3.amazonaws.com/upload/1', s3Key: 'workflow-inbox/hash/0-inv.pdf', name: 'inv.pdf', contentType: 'application/pdf', size: 12345 },
      { url: 'https://s3.amazonaws.com/upload/2', s3Key: 'workflow-inbox/hash/1-bol.png', name: 'bol.png', contentType: 'image/png', size: 2048 },
    ];
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse({ uploadUrls }), makeCommitResponse()],
    });

    ctx.processAgentInboxEmails();

    expect(state.fetched.map((f) => f.url)).toEqual([
      WEBHOOK_URL,
      'https://s3.amazonaws.com/upload/1',
      'https://s3.amazonaws.com/upload/2',
      WEBHOOK_URL,
    ]);
    expect(state.fetched[1].opts.method).toBe('put');

    const commit = commitCalls(state)[0].payload;
    expect(commit.role).toBe('AP');
    expect(commit.attachments).toEqual([
      { s3Key: 'workflow-inbox/hash/0-inv.pdf', name: 'inv.pdf', contentType: 'application/pdf', size: 12345 },
      { s3Key: 'workflow-inbox/hash/1-bol.png', name: 'bol.png', contentType: 'image/png', size: 2048 },
    ]);
  });

  it('does not reprocess an already-acked message and still posts a new one in the thread', () => {
    const m1 = makeMessage({ id: 'a1', threadId: 't1' });
    const m2 = makeMessage({ id: 'a2', threadId: 't1' });
    const { ctx, state } = makeBridge({
      properties: { 'agentinbox:msg:a1': 'ok:2026-10-01T00:00:00Z' },
      messages: [m1, m2],
    });

    ctx.processAgentInboxEmails();

    expect(prepareCalls(state).map((f) => f.payload.messageId)).toEqual(['a2']);
    expect(state.properties['agentinbox:msg:a2']).toMatch(/^ok:/);
  });

  it('acks a duplicate without uploading attachments', () => {
    const m = makeMessage({ id: 'd1' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse({ duplicate: true })],
    });

    ctx.processAgentInboxEmails();

    expect(state.fetched).toHaveLength(1);
    expect(state.properties['agentinbox:msg:d1']).toMatch(/^ok:/);
  });

  it('labels a 422 prepare (bad role or payload) and acks it', () => {
    const m = makeMessage({ id: 'e1' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [{ code: 422, body: JSON.stringify({ error: 'role must be one of QUOTE, CAPACITY, AP, TENDER' }) }],
    });

    ctx.processAgentInboxEmails();

    expect(state.properties['agentinbox:msg:e1']).toMatch(/^reviewed:/);
    expect(m.getThread()._labels.map((l) => l.getName())).toContain('agent-inbox-needs-review');
  });

  it('does not ack a 503 commit so S3 consistency is retried', () => {
    const m = makeMessage({ id: 'e2' });
    const { ctx, state } = makeBridge({
      messages: [m],
      responses: [makePrepareResponse(), { code: 503, body: JSON.stringify({ error: 'attachment verification failed' }) }],
    });

    expect(() => ctx.processAgentInboxEmails()).toThrow();
    expect(state.properties['agentinbox:msg:e2']).toBeUndefined();
  });

  it('refuses to run without the deploy-output URL', () => {
    const { ctx } = makeBridge({ properties: { WORKFLOW_AGENT_URL: '' }, messages: [makeMessage({ id: 'u1' })] });

    expect(() => ctx.processAgentInboxEmails()).toThrow(/WORKFLOW_AGENT_URL/);
    expect(() => ctx.setupAgentEmailBridge()).toThrow(/WORKFLOW_AGENT_URL/);
  });

  it('refuses setup when no inbox address is configured', () => {
    const { ctx } = makeBridge({
      properties: {
        AGENT_INBOX_QUOTE: '', AGENT_INBOX_TENDER: '', AGENT_INBOX_AP: '', AGENT_INBOX_CAPACITY: '',
      },
    });

    expect(() => ctx.setupAgentEmailBridge()).toThrow(/inbox/i);
  });

  it('setup creates the label and exactly one 5-minute trigger', () => {
    const { ctx, state } = makeBridge({});

    ctx.setupAgentEmailBridge();
    expect(Object.keys(state.labels)).toContain('agent-inbox-needs-review');
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0].handlerFunction).toBe('processAgentInboxEmails');
    expect(state.triggers[0].minutes).toBe(5);

    ctx.setupAgentEmailBridge();
    expect(state.triggers).toHaveLength(1);
  });

  it('falls back to the project WEBHOOK_SECRET constant when no secret property is set', () => {
    const { ctx, state } = makeBridge({
      properties: { WORKFLOW_AGENT_SECRET: '' },
      messages: [makeMessage({ id: 's1' })],
      globals: { WEBHOOK_SECRET: 'fallback-secret' },
    });

    ctx.processAgentInboxEmails();

    expect(prepareCalls(state)[0].payload.secret).toBe('fallback-secret');
  });

  it('truncates a long body and keeps the truncation indicator', () => {
    const m = makeMessage({ id: 'l1', plainBody: 'x'.repeat(60_000) });
    const { ctx, state } = makeBridge({ messages: [m] });

    ctx.processAgentInboxEmails();

    const sent = prepareCalls(state)[0].payload.bodyText;
    expect(sent.length).toBeLessThanOrEqual(50_000);
    expect(sent.endsWith('[truncated]')).toBe(true);
  });
});
