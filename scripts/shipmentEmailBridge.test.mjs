import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsCode = readFileSync(resolve(__dirname, 'shipmentEmailBridge.gs'), 'utf8');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function makeMessage(over = {}) {
  const h = { 'Message-ID': `<${over.id ?? 'm1'}@x>`, 'In-Reply-To': '', References: '', ...(over.headers ?? {}) };
  return {
    getId: () => over.id ?? 'm1',
    getFrom: () => over.from ?? 'Carrier Ops <ops@carrier.com>',
    getTo: () => over.to ?? 'ai4bcat+tracking.shp-1@gmail.com',
    getCc: () => over.cc ?? '',
    getSubject: () => over.subject ?? 'Re: Rate confirmation — load 20002 [ref shp-1]',
    getPlainBody: () => over.body ?? 'we will pick up at 8',
    getHeader: (k) => h[k] ?? '',
    getDate: () => new Date('2026-11-10T15:00:00.000Z'),
    getAttachments: () => over.attachments ?? [],
  };
}

function makeBridge({ properties = {}, messages = [], fetchStatus = 200, globals = {} } = {}) {
  const props = { SHIPMENT_EMAIL_URL: 'https://example.com/intake', SHIPMENT_EMAIL_SECRET: 's3cret', ...properties };
  const state = { searches: [], posts: [], triggers: [] };
  const ctx = vm.createContext({
    console, JSON, Date, Array, Object, String, Number, Math, parseInt, isNaN, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => state.triggers, newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => state.triggers.push({ getHandlerFunction: () => fn }) }) }) }) },
    Utilities: { base64Encode: (b) => `b64(${b})` },
    GmailApp: { search: (q, start) => { state.searches.push({ q, start }); return start === 0 ? [{ getMessages: () => messages }] : []; } },
    UrlFetchApp: { fetch: (url, opts) => { state.posts.push({ url, body: JSON.parse(opts.payload) }); return { getResponseCode: () => fetchStatus, getContentText: () => '' }; } },
    ...globals,
  });
  vm.runInContext(gsCode, ctx);
  return { ctx, state, props };
}

describe('shipment e-mail bridge', () => {
  it('searches the last 3 days for the plus-address and the [ref] token', () => {
    const { ctx, state } = makeBridge({ messages: [makeMessage()] });
    ctx.processShipmentEmails();
    expect(state.searches[0].q).toBe('(subject:"ref shp-" OR "ai4bcat+tracking" OR "ai4bcat.tracking") -in:trash -in:spam newer_than:3d');
  });

  it('posts a reply with its headers, and does not send it twice', () => {
    const { ctx, state } = makeBridge({ messages: [makeMessage({ id: 'a1', headers: { 'In-Reply-To': '<out@email.amazonses.com>' } })] });
    ctx.processShipmentEmails();
    ctx.processShipmentEmails();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].body).toMatchObject({
      secret: 's3cret', messageId: '<a1@x>', from: 'Carrier Ops <ops@carrier.com>', inReplyTo: '<out@email.amazonses.com>',
      subject: 'Re: Rate confirmation — load 20002 [ref shp-1]', body: 'we will pick up at 8', receivedAt: '2026-11-10T15:00:00.000Z',
    });
  });

  it('skips the mailbox own sends', () => {
    const { ctx, state } = makeBridge({ messages: [makeMessage({ id: 'o1', from: 'BCAT <ai4bcat@gmail.com>' })] });
    ctx.processShipmentEmails();
    expect(state.posts).toHaveLength(0);
  });

  it('remembers an unroutable message (422) but retries after a server error', () => {
    const unrouted = makeBridge({ messages: [makeMessage({ id: 'u1' })], fetchStatus: 422 });
    unrouted.ctx.processShipmentEmails();
    unrouted.ctx.processShipmentEmails();
    expect(unrouted.state.posts).toHaveLength(1);
    const broken = makeBridge({ messages: [makeMessage({ id: 'e1' })], fetchStatus: 502 });
    broken.ctx.processShipmentEmails();
    broken.ctx.processShipmentEmails();
    expect(broken.state.posts).toHaveLength(2);
  });

  it('sends attachments as base64 and drops oversized ones', () => {
    const att = (name, size) => ({ getName: () => name, getContentType: () => 'application/pdf', getSize: () => size, getBytes: () => name });
    const { ctx, state } = makeBridge({ messages: [makeMessage({ attachments: [att('pod.pdf', 1000), att('huge.pdf', 9 * 1024 * 1024)] })] });
    ctx.processShipmentEmails();
    expect(state.posts[0].body.attachments).toEqual([{ name: 'pod.pdf', contentType: 'application/pdf', base64: 'b64(pod.pdf)' }]);
  });

  it('honours the lookback override and installs exactly one trigger on setup', () => {
    const { ctx, state } = makeBridge({ properties: { SHIPMENT_LOOKBACK_DAYS: '10' }, messages: [] });
    ctx.processShipmentEmails();
    expect(state.searches[0].q).toMatch(/newer_than:10d$/);
    ctx.setupShipmentEmailBridge();
    ctx.setupShipmentEmailBridge();
    expect(state.triggers).toHaveLength(1);
  });

  it('refuses to run without its URL and secret', () => {
    const { ctx } = makeBridge({ properties: { SHIPMENT_EMAIL_URL: '', SHIPMENT_EMAIL_SECRET: '' } });
    expect(() => ctx.processShipmentEmails()).toThrow(/SHIPMENT_EMAIL_URL/);
  });
});
