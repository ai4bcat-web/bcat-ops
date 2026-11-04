import { describe, expect, it } from 'vitest'
import { CARRIER_INBOX_CALL_FIXTURES } from '../../../../src/lib/carrierInbox/fixtures'
import { handleCarrierCall, MAX_CALL_BODY_BYTES, sha256Hex, type FunctionUrlEvent } from './voice'
import { makeCsRig, offerRaw, type CsRig } from './testkit'

const SECRET = 'voice-secret-for-tests'
const CALL = CARRIER_INBOX_CALL_FIXTURES[0].call

function rig(over: { enabled?: boolean; voiceEnabled?: boolean; secret?: string | null } = {}): CsRig {
  const r = makeCsRig({ cfg: { enabled: over.enabled ?? true } })
  const cfg = r.store.config.value!
  r.store.config.value = {
    ...cfg,
    voice: { ...cfg.voice, enabled: over.voiceEnabled ?? true, secretHash: over.secret === null ? null : sha256Hex(over.secret ?? SECRET) },
  }
  r.model.answer = () => offerRaw({ loadRefs: ['ZZAL1001'], rateDollars: 1820 })
  return r
}

function post(body: unknown, over: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    requestContext: { http: { method: 'POST', path: '/carrier-call' }, domainName: 'abc.lambda-url.us-east-2.on.aws' },
    rawPath: '/carrier-call',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...over,
  }
}

const parse = (r: { body: string }): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>

describe('voice door', () => {
  it('files a call as a PHONE-sourced hand-over keyed on the callSid, and answers a replay as a duplicate', async () => {
    const r = rig()
    const first = await handleCarrierCall(post({ secret: SECRET, ...CALL }), r.deps)
    expect(first.statusCode).toBe(200)
    expect(parse(first)).toMatchObject({ ok: true, outcome: 'FILED' })
    expect(r.files.calls).toHaveLength(1)
    expect(r.files.calls[0]).toMatchObject({
      source: 'CALL', mailboxId: null, fromEmail: null, fromName: CALL.callerNumber, messageId: null,
      call: { callSid: CALL.callSid, durationSec: 189, outcome: 'TRANSFERRED', recordingUrl: CALL.recordingUrl },
      extraction: { kind: 'OFFER', rateCents: 182000 },
    })
    expect(r.files.calls[0].body).toContain('eighteen twenty')
    // The voice agent's own structured fields are hints inside the model's fence input.
    expect(r.model.calls[0].source).toBe('CALL')

    const replay = await handleCarrierCall(post({ secret: SECRET, ...CALL }), r.deps)
    expect(parse(replay)).toEqual({ ok: true, duplicate: true })
    expect(r.files.calls).toHaveLength(2)
    expect(r.files.calls[1].sourceKey).toBe(r.files.calls[0].sourceKey)
  })

  it('records the function URL and the call on first success', async () => {
    const r = rig()
    await handleCarrierCall(post({ secret: SECRET, ...CALL }), r.deps)
    expect(r.store.state.value.voice).toMatchObject({
      url: 'https://abc.lambda-url.us-east-2.on.aws/', lastError: null, calls24h: 1, lastCallAt: r.clock.now.toISOString(),
    })
  })

  it('rejects a wrong or missing secret with 401 and does no work', async () => {
    const r = rig()
    for (const body of [{ ...CALL, secret: 'nope' }, { ...CALL }]) {
      expect((await handleCarrierCall(post(body), r.deps)).statusCode).toBe(401)
    }
    expect(r.model.calls).toHaveLength(0)
    expect(r.files.calls).toHaveLength(0)
  })

  it('answers 503 (retry later) while voice is off, or no secret has been issued', async () => {
    expect((await handleCarrierCall(post({ secret: SECRET, ...CALL }), rig({ voiceEnabled: false }).deps)).statusCode).toBe(503)
    expect((await handleCarrierCall(post({ secret: SECRET, ...CALL }), rig({ secret: null }).deps)).statusCode).toBe(503)
    expect((await handleCarrierCall(post({ secret: SECRET, ...CALL }), rig({ enabled: false }).deps)).statusCode).toBe(503)
  })

  it('validates the request: path, method, size, JSON, callSid, transcript', async () => {
    const r = rig()
    expect((await handleCarrierCall(post({ secret: SECRET, ...CALL }, { rawPath: '/other', requestContext: { http: { method: 'POST', path: '/other' } } }), r.deps)).statusCode).toBe(404)
    expect((await handleCarrierCall(post({}, { requestContext: { http: { method: 'GET', path: '/carrier-call' } } }), r.deps)).statusCode).toBe(404)
    expect((await handleCarrierCall(post('x'.repeat(MAX_CALL_BODY_BYTES + 1)), r.deps)).statusCode).toBe(413)
    expect((await handleCarrierCall(post('{nope'), r.deps)).statusCode).toBe(400)
    expect((await handleCarrierCall(post({ secret: SECRET, ...CALL, callSid: '' }), r.deps)).statusCode).toBe(400)
    expect((await handleCarrierCall(post({ secret: SECRET, ...CALL, transcript: 5 }), r.deps)).statusCode).toBe(400)
    expect(r.files.calls).toHaveLength(0)
  })

  it('drops an abandoned or empty call without a model call', async () => {
    const r = rig()
    const abandoned = await handleCarrierCall(post({ secret: SECRET, ...CALL, outcome: 'ABANDONED' }), r.deps)
    const short = await handleCarrierCall(post({ secret: SECRET, ...CALL, callSid: 'CAshort0001', transcript: 'hi' }), r.deps)
    expect(parse(abandoned)).toMatchObject({ ok: true, outcome: 'DROPPED' })
    expect(parse(short)).toMatchObject({ ok: true, outcome: 'DROPPED' })
    expect(r.model.calls).toHaveLength(0)
    expect(r.files.calls).toHaveLength(0)
  })

  it('files nothing and tells the agent to retry when classification fails', async () => {
    const r = rig()
    r.model.answer = () => new Error('model down')
    const res = await handleCarrierCall(post({ secret: SECRET, ...CALL }), r.deps)
    expect(res.statusCode).toBe(503)
    expect(parse(res)).toEqual({ ok: false, error: 'try again' })
    expect(r.files.calls).toHaveLength(0)
    expect(r.store.state.value.voice.lastError).toContain('retry')
  })

  it('drops a call the model says is not an offer', async () => {
    const r = rig()
    r.model.answer = () => offerRaw({ kind: 'NOT_RELEVANT' })
    const res = await handleCarrierCall(post({ secret: SECRET, ...CALL }), r.deps)
    expect(parse(res)).toMatchObject({ ok: true, outcome: 'NOT_OFFER' })
    expect(r.files.calls).toHaveLength(0)
  })

  it('keeps only an https recording link', async () => {
    const r = rig()
    await handleCarrierCall(post({ secret: SECRET, ...CALL, recordingUrl: 'javascript:alert(1)' }), r.deps)
    expect(r.files.calls[0].call?.recordingUrl).toBeNull()
  })
})
