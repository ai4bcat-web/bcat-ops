import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsCode = readFileSync(resolve(__dirname, 'loadsEmailBridge.gs'), 'utf8');

const BASE = 'https://fn.lambda-url.us-east-1.on.aws';
const PREPARE = `${BASE}/email-intake/prepare`;
const COMMIT = `${BASE}/email-intake/commit`;

// ── Test harness ─────────────────────────────────────────────────────────────

function loadScript(env = {}) {
  const context = vm.createContext({
    console: { log() {}, error() {} },
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Math,
    RegExp,
    parseInt,
    isNaN,
    Error,
    ...env,
  });
  vm.runInContext(gsCode, context);
  return context;
}

function makeAttachment(overrides = {}) {
  const blob = { bytes: overrides.content ?? 'pdf-bytes' };
  return {
    name: overrides.name ?? 'ratecon.pdf',
    contentType: overrides.contentType ?? 'application/pdf',
    size: overrides.size ?? 204_800,
    disposition: overrides.disposition ?? 'attachment',
    getName() { return this.name; },
    getContentType() { return this.contentType; },
    getSize() { return this.size; },
    getContentDisposition() { return this.disposition; },
    copyBlob() { return blob; },
  };
}

function makeMessage(overrides = {}) {
  const headers = {};
  if (overrides.deliveredTo !== undefined) headers['Delivered-To'] = overrides.deliveredTo;
  if (overrides.listId !== undefined) headers['List-ID'] = overrides.listId;
  return {
    id: overrides.id ?? 'm1',
    to: overrides.to ?? 'Ivan Loads <ivanloads@bcatcorp.com>',
    cc: overrides.cc ?? '',
    headers,
    subject: overrides.subject ?? 'Fwd: Rate Confirmation - 9880338',
    from: overrides.from ?? 'Ryne Bandolik <Ryne@bcatcorp.com>',
    plainBody: overrides.plainBody ?? 'driver ROY',
    attachments: overrides.attachments ?? [makeAttachment()],
    getId() { return this.id; },
    getTo() { return this.to; },
    getCc() { return this.cc; },
    getHeader(name) { return this.headers[name] || ''; },
    getSubject() { return this.subject; },
    getFrom() { return this.from; },
    getPlainBody() { return this.plainBody; },
    getAttachments() { return this.attachments; },
    getThread() { return this._thread; },
  };
}

function makeBridge({ properties = {}, messages = [], prepare, commit, s3 } = {}) {
  const state = {
    properties: { LOADS_WEBHOOK_URL: BASE, LOADS_WEBHOOK_SECRET: 'shh', ...properties },
    labels: {},
    labelledThreads: [],
    triggers: [],
    fetched: [],
    prepare: prepare ?? { code: 200, body: JSON.stringify({ submissionId: 'email:m1', driverId: 'd', driverName: 'Roy Workman', driverMatched: true, targets: [{ pageNumber: 1, url: 'https://s3/put/1', s3Key: 'driver-docs/d/email:m1/RATECON/1-1.pdf' }] }) },
    commit: commit ?? { code: 200, body: JSON.stringify({ ok: true, notified: true }) },
    s3: s3 ?? { code: 200, body: '' },
  };

  function makeThread(msgs) {
    const thread = {
      getMessages: () => msgs,
      addLabel: (label) => state.labelledThreads.push(label.getName()),
    };
    msgs.forEach((m) => { m._thread = thread; });
    return thread;
  }
  const threads = messages.map((m) => makeThread([m]));

  const mocks = {
    GmailApp: {
      getUserLabelByName: (name) => state.labels[name] || null,
      createLabel: (name) => {
        const label = { getName: () => name };
        state.labels[name] = label;
        return label;
      },
      search: (query, start, max) => {
        state.searchQuery = query;
        return threads.slice(start, start + max);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in state.properties ? state.properties[key] : null),
        setProperty: (key, value) => { state.properties[key] = String(value); },
      }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        let payload = null;
        if (typeof opts.payload === 'string') {
          try { payload = JSON.parse(opts.payload); } catch { payload = null; }
        } else { payload = opts.payload; }
        state.fetched.push({ url, payload, opts });
        const r = url === PREPARE ? state.prepare : url === COMMIT ? state.commit : state.s3;
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => state.triggers,
      newTrigger: (fn) => ({
        timeBased: () => ({ everyMinutes: (mins) => ({ create: () => state.triggers.push({ getHandlerFunction: () => fn, minutes: mins }) }) }),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  };

  return { ctx: loadScript(mocks), state };
}

const ack = (state, id) => state.properties[`loads:msg:${id}`];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('loadsEmailBridge.gs', () => {
  it('runs prepare → presigned PUT → commit and acks the message', () => {
    const { ctx, state } = makeBridge({ messages: [makeMessage({ id: 'm1' })] });

    ctx.processLoadsEmails();

    expect(state.fetched.map((f) => f.url)).toEqual([PREPARE, 'https://s3/put/1', COMMIT]);
    expect(state.fetched[0].payload).toMatchObject({
      secret: 'shh',
      gmailMessageId: 'm1',
      body: 'driver ROY',
      attachments: [{ fileName: 'ratecon.pdf', contentType: 'application/pdf', byteSize: 204_800 }],
    });
    expect(state.fetched[1].opts.method).toBe('put');
    expect(state.fetched[2].payload).toMatchObject({
      submissionId: 'email:m1',
      attachments: [{ fileName: 'ratecon.pdf', contentType: 'application/pdf', byteSize: 204_800, s3Key: 'driver-docs/d/email:m1/RATECON/1-1.pdf' }],
    });
    expect(ack(state, 'm1')).toMatch(/^ok:/);
  });

  it('never calls the Lambda for a message whose only parts are unusable', () => {
    // prepare rejects an empty attachment list with 400, so posting these would
    // burn a request on every 5-minute poll forever.
    const attachments = [
      makeAttachment({ name: 'logo.png', contentType: 'image/png', disposition: 'inline' }),
      makeAttachment({ name: 'notes.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      makeAttachment({ name: 'huge.pdf', size: 20 * 1024 * 1024 }),
    ];
    const { ctx, state } = makeBridge({ messages: [makeMessage({ id: 'm2', attachments })] });

    ctx.processLoadsEmails();

    expect(state.fetched).toEqual([]);
    expect(state.labelledThreads).toEqual(['loads-needs-review']);
    expect(ack(state, 'm2')).toMatch(/^no-attachment:/);
  });

  it('sends the normalised content type to both prepare and the presigned PUT', () => {
    // The presigned URL is signed with the content type prepare was given, so a
    // PUT with Gmail's generic octet-stream would fail the S3 signature check.
    const attachments = [makeAttachment({ name: 'RC_LILY20335.PDF', contentType: 'application/octet-stream' })];
    const { ctx, state } = makeBridge({ messages: [makeMessage({ id: 'm3', attachments })] });

    ctx.processLoadsEmails();

    expect(state.fetched[0].payload.attachments[0].contentType).toBe('application/pdf');
    expect(state.fetched[1].opts.contentType).toBe('application/pdf');
  });

  it('acks our own notification mail so the ivanloads loop terminates', () => {
    const { ctx, state } = makeBridge({
      messages: [makeMessage({ id: 'm4', from: 'onboarding@bcatcorp.com', subject: 'New load from Lee Lara' })],
      prepare: { code: 200, body: JSON.stringify({ skipped: true, reason: 'own-notification' }) },
    });

    ctx.processLoadsEmails();

    expect(state.fetched.map((f) => f.url)).toEqual([PREPARE]);
    expect(ack(state, 'm4')).toMatch(/^skipped-own-notification:/);
  });

  it('leaves an in-flight message unacked so a later poll can finish it', () => {
    const { ctx, state } = makeBridge({
      messages: [makeMessage({ id: 'm5' })],
      prepare: { code: 200, body: JSON.stringify({ skipped: true, reason: 'in-flight', submissionId: 'email:m5' }) },
    });

    ctx.processLoadsEmails();

    expect(ack(state, 'm5')).toBeUndefined();
  });

  it('labels and acks a message the Lambda rejects, but retries a transient failure', () => {
    const rejected = makeBridge({
      messages: [makeMessage({ id: 'm6' })],
      prepare: { code: 400, body: '{"error":"attachment 1 unsupported content type"}' },
    });
    rejected.ctx.processLoadsEmails();
    expect(rejected.state.labelledThreads).toEqual(['loads-needs-review']);
    expect(ack(rejected.state, 'm6')).toMatch(/^reviewed:/);

    const transient = makeBridge({
      messages: [makeMessage({ id: 'm7' })],
      prepare: { code: 502, body: 'bad gateway' },
    });
    expect(() => transient.ctx.processLoadsEmails()).toThrow(/webhook failure/);
    expect(ack(transient.state, 'm7')).toBeUndefined();
  });

  it('retries without acking when an attachment upload fails', () => {
    const { ctx, state } = makeBridge({
      messages: [makeMessage({ id: 'm8' })],
      s3: { code: 403, body: 'SignatureDoesNotMatch' },
    });

    expect(() => ctx.processLoadsEmails()).toThrow(/webhook failure/);
    expect(state.fetched.map((f) => f.url)).toEqual([PREPARE, 'https://s3/put/1']);
    expect(ack(state, 'm8')).toBeUndefined();
  });

  it('flags a commit that saved the docs but could not notify dispatch', () => {
    const { ctx, state } = makeBridge({
      messages: [makeMessage({ id: 'm9' })],
      commit: { code: 200, body: JSON.stringify({ ok: true, notified: false, error: 'slack 500' }) },
    });

    ctx.processLoadsEmails();

    expect(state.labelledThreads).toEqual(['loads-needs-review']);
    expect(ack(state, 'm9')).toMatch(/^ok:/);
  });

  it('derives both route URLs however the webhook property is pasted', () => {
    for (const raw of [BASE, `${BASE}/`, `${BASE}/email-intake`, `${BASE}/email-intake/prepare`]) {
      const { ctx, state } = makeBridge({ messages: [makeMessage({ id: 'u' })], properties: { LOADS_WEBHOOK_URL: raw } });
      ctx.processLoadsEmails();
      expect(state.fetched.map((f) => f.url)).toEqual([PREPARE, 'https://s3/put/1', COMMIT]);
    }
  });

  it('matches mail that only names the group in Delivered-To or List-ID', () => {
    const viaDelivered = makeBridge({ messages: [makeMessage({ id: 'h1', to: 'someone@else.com', deliveredTo: 'ivanloads@bcatcorp.com' })] });
    viaDelivered.ctx.processLoadsEmails();
    expect(ack(viaDelivered.state, 'h1')).toMatch(/^ok:/);

    const viaListId = makeBridge({ messages: [makeMessage({ id: 'h2', to: 'someone@else.com', listId: '<ivanloads.bcatcorp.com>' })] });
    viaListId.ctx.processLoadsEmails();
    expect(ack(viaListId.state, 'h2')).toMatch(/^ok:/);

    const unrelated = makeBridge({ messages: [makeMessage({ id: 'h3', to: 'ivanfactoring@bcatcorp.com' })] });
    unrelated.ctx.processLoadsEmails();
    expect(unrelated.state.fetched).toEqual([]);
    expect(ack(unrelated.state, 'h3')).toBeUndefined();
  });

  it('setup installs exactly one trigger and refuses to run unconfigured', () => {
    const { ctx, state } = makeBridge();
    ctx.setupLoadsEmailBridge();
    ctx.setupLoadsEmailBridge();
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0].getHandlerFunction()).toBe('processLoadsEmails');
    expect(state.triggers[0].minutes).toBe(5);

    const bare = makeBridge({ properties: { LOADS_WEBHOOK_URL: '' } });
    expect(() => bare.ctx.setupLoadsEmailBridge()).toThrow(/LOADS_WEBHOOK_URL/);
  });
});
