import { describe, expect, it } from 'vitest'
import { CARRIER_INBOX_CALL_FIXTURES, CARRIER_INBOX_MAIL_FIXTURES } from '../../../../src/lib/carrierInbox/fixtures'
import { csDispatch, csAuthorize, type CsIdentity } from './actions'
import { csUserId } from './deps'
import { sha256Hex } from './voice'
import { makeCsRig, MAILBOX, type CsRig } from './testkit'

const ADMIN: CsIdentity = { sub: 's1', username: 'admin-1', claims: { email: 'boss@bcatcorp.com', 'cognito:groups': ['ADMIN'] } }
const owner: CsIdentity = { sub: 's0', username: 'ryne', claims: { email: 'ryne@bcatcorp.com' } }
const rep = (groups: string[]): CsIdentity => ({ sub: 's2', username: 'rep-1', claims: { email: 'rep@bcatcorp.com', 'cognito:groups': groups } })

const call = (rig: CsRig, action: string, input: unknown, who: CsIdentity = ADMIN): Promise<Record<string, unknown>> =>
  csDispatch(action, input, who, rig.deps) as Promise<Record<string, unknown>>

describe('caller rules', () => {
  const rig = makeCsRig()
  it('lets a page-loads-only rep read status and poll, but nothing else', async () => {
    const r = rep(['page-loads'])
    await expect(csDispatch('CS_STATUS', {}, r, rig.deps)).resolves.toBeTruthy()
    await expect(csDispatch('CS_POLL_NOW', {}, r, rig.deps)).resolves.toBeTruthy()
    for (const action of ['CS_SAVE_SETTINGS', 'CS_OAUTH_START', 'CS_DISCONNECT', 'CS_SET_PAUSED', 'CS_VOICE_ROTATE_SECRET']) {
      await expect(csDispatch(action, {}, r, rig.deps), action).rejects.toThrow(/Forbidden/)
    }
  })

  it('refuses a caller with no desk group even for reads, and an anonymous call', async () => {
    await expect(csDispatch('CS_STATUS', {}, rep(['page-drivers']), rig.deps)).rejects.toThrow(/Forbidden/)
    await expect(csDispatch('CS_STATUS', {}, null, rig.deps)).rejects.toThrow(/Unauthorized/)
    await expect(csDispatch('CS_NOPE', {}, ADMIN, rig.deps)).rejects.toThrow(/Unknown action/)
  })

  it('keeps the simulated mailbox to an ADMIN on the dev stack, enforced in code', async () => {
    for (const action of ['CS_CONNECT_SIMULATED', 'CS_SIM_INJECT_MAIL', 'CS_SIM_INJECT_CALL', 'CS_SIM_RESET', 'CS_SIM_PURGE_TEST']) {
      await expect(csAuthorize(action, ADMIN, false), action).rejects.toThrow(/dev stack/)
      await expect(csAuthorize(action, rep(['page-loads']), true), action).rejects.toThrow(/Forbidden/)
      expect((await csAuthorize(action, owner, true)).isAdmin).toBe(true)
    }
  })

  it('resolves the e-mail of an access token (no email claim) through the resolver, and still refuses without one', async () => {
    const access: CsIdentity = { sub: 'u-1', username: 'uuid-1', claims: { 'cognito:groups': ['page-loads'] } }
    await expect(csAuthorize('CS_STATUS', access, false)).rejects.toThrow(/could not resolve caller/)
    await expect(csAuthorize('CS_STATUS', access, false, async () => '')).rejects.toThrow(/could not resolve caller/)
    const caller = await csAuthorize('CS_STATUS', access, false, async (u) => (u === 'uuid-1' ? 'Rep@BCATcorp.com' : ''))
    expect(caller).toMatchObject({ email: 'rep@bcatcorp.com', userId: 'uuid-1', isAdmin: false })
    const boss: CsIdentity = { sub: 'u-2', username: 'uuid-2', claims: {} }
    expect((await csAuthorize('CS_SAVE_SETTINGS', boss, false, async () => 'ryne@bcatcorp.com')).isAdmin).toBe(true)
  })
})

describe('status and the voice secret', () => {
  it('rotates the secret once, stores only its hash, and never shows it or a nonce back', async () => {
    const rig = makeCsRig()
    const first = await call(rig, 'CS_VOICE_ROTATE_SECRET', {})
    const secret = first.secret as string
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(rig.store.config.value!.voice.secretHash).toBe(sha256Hex(secret))
    expect(rig.store.config.value!.voice.rotatedAt).toBe(rig.clock.now.toISOString())

    await call(rig, 'CS_OAUTH_START', { mailboxId: 'm1', redirectUri: 'https://ops.zz-bcat.test/tms/rates/spot/callback' })
    const status = JSON.stringify(await call(rig, 'CS_STATUS', {}, rep(['page-loads'])))
    expect(status).not.toContain(secret)
    expect(status).not.toContain('secretHash')
    expect(status).not.toContain('pendingStateHash')
    expect(status).not.toContain('pendingStateExp')
    expect(JSON.parse(status)).toMatchObject({ config: { voice: { hasSecret: true } }, devStack: false, gmailProvider: { mode: 'LIVE' } })

    const second = await call(rig, 'CS_VOICE_ROTATE_SECRET', {})
    expect(second.secret).not.toBe(secret)
    expect(rig.store.config.value!.voice.secretHash).toBe(sha256Hex(second.secret as string))
  })
})

describe('settings', () => {
  it('refuses a stale save and a floor below the safety minimum, keeping the stored config', async () => {
    const rig = makeCsRig()
    const stored = rig.store.config.value!
    const view = (await call(rig, 'CS_STATUS', {})).config as { version: number }
    await expect(call(rig, 'CS_SAVE_SETTINGS', { config: { ...stored, lookbackHours: 48 }, expectedVersion: view.version + 5 })).rejects.toThrow(/changed since/)
    await expect(call(rig, 'CS_SAVE_SETTINGS', { config: { ...stored, autoFileMinScore: 0.5 }, expectedVersion: view.version })).rejects.toThrow()
    expect(rig.store.config.value!.autoFileMinScore).toBe(stored.autoFileMinScore)
    const saved = await call(rig, 'CS_SAVE_SETTINGS', { config: { ...stored, lookbackHours: 48 }, expectedVersion: view.version })
    expect((saved.config as { lookbackHours: number }).lookbackHours).toBe(48)
    expect(rig.audits[rig.audits.length - 1]).toMatchObject({ action: 'CS_SAVE_SETTINGS', changes: { keys: ['lookbackHours'] } })
  })

  it('cannot switch the feature on with nothing connected to listen to', async () => {
    const rig = makeCsRig({ connected: false, cfg: { enabled: false } })
    const stored = rig.store.config.value!
    await expect(call(rig, 'CS_SAVE_SETTINGS', { config: { ...stored, enabled: true }, expectedVersion: stored.version })).rejects.toThrow(/Connect a mailbox/)
  })

  it('removing a mailbox revokes its grant and clears its state', async () => {
    const rig = makeCsRig()
    rig.oauth.tokens.set(csUserId('m1'), { refreshToken: 'rt', scope: 's', googleEmail: 'ai4bcat@gmail.com', obtainedAt: 'x' })
    const stored = rig.store.config.value!
    await call(rig, 'CS_SAVE_SETTINGS', { config: { ...stored, mailboxes: [], enabled: false }, expectedVersion: stored.version })
    expect(rig.oauth.tokens.has(csUserId('m1'))).toBe(false)
    expect(rig.oauth.revoked).toEqual(['rt'])
    expect(rig.store.state.value.mailboxes.m1).toMatchObject({ status: 'NOT_CONNECTED', historyId: null })
  })

  it('pauses and resumes a mailbox through the config', async () => {
    const rig = makeCsRig()
    await call(rig, 'CS_SET_PAUSED', { mailboxId: 'm1', paused: true })
    expect(rig.store.config.value!.mailboxes[0].paused).toBe(true)
    await call(rig, 'CS_SET_PAUSED', { mailboxId: 'm1', paused: false })
    expect(rig.store.config.value!.mailboxes[0].paused).toBe(false)
  })
})

describe('connecting a Google mailbox', () => {
  const REDIRECT = 'https://ops.zz-bcat.test/tms/rates/spot/callback'
  const start = async (rig: CsRig): Promise<string> => {
    const { url } = await call(rig, 'CS_OAUTH_START', { mailboxId: 'm1', redirectUri: REDIRECT }) as { url: string }
    return new URL(url).searchParams.get('state')!
  }

  it('needs the Google client, and only offers the allowed redirect', async () => {
    const rig = makeCsRig({ connected: false })
    rig.oauth.client = null
    await expect(call(rig, 'CS_OAUTH_START', { mailboxId: 'm1', redirectUri: REDIRECT })).rejects.toThrow(/NOT_CONFIGURED/)
    rig.oauth.client = { clientId: 'cid', clientSecret: 'cs', allowedDomain: '' }
    await expect(call(rig, 'CS_OAUTH_START', { mailboxId: 'm1', redirectUri: 'https://evil.example/tms/rates/spot/callback' })).rejects.toThrow(/not allowed/)
  })

  it('stores only a hash of the state, then connects the verified account once', async () => {
    const rig = makeCsRig({ connected: false })
    const state = await start(rig)
    expect(state.startsWith('cs.m1.')).toBe(true)
    expect(JSON.stringify(rig.store.state.value)).not.toContain(state)
    expect(rig.store.state.value.mailboxes.m1.status).toBe('PENDING')

    rig.oauth.identity = { email: 'ai4bcat@gmail.com', emailVerified: true, hd: null }
    const done = await call(rig, 'CS_OAUTH_FINISH', { code: 'c', state, redirectUri: REDIRECT })
    expect(done).toEqual({ mailboxId: 'm1' })
    expect(rig.oauth.tokens.get(csUserId('m1'))).toMatchObject({ googleEmail: 'ai4bcat@gmail.com' })
    expect(rig.store.state.value.mailboxes.m1).toMatchObject({ status: 'CONNECTED', historyId: null, pendingStateHash: null })

    await expect(call(rig, 'CS_OAUTH_FINISH', { code: 'c', state, redirectUri: REDIRECT })).rejects.toThrow(/not valid or has expired/)
  })

  it('writes nothing when Google signs in a different account than the mailbox', async () => {
    const rig = makeCsRig({ connected: false })
    const state = await start(rig)
    rig.oauth.identity = { email: 'someone-else@gmail.com', emailVerified: true, hd: null }
    await expect(call(rig, 'CS_OAUTH_FINISH', { code: 'c', state, redirectUri: REDIRECT })).rejects.toThrow(/own Google account/)
    expect(rig.oauth.tokens.size).toBe(0)
    expect(rig.store.state.value.mailboxes.m1.status).toBe('PENDING')
  })

  it('refuses an expired sign-in and one without read-only scope or an unverified identity', async () => {
    const rig = makeCsRig({ connected: false })
    const state = await start(rig)
    rig.clock.now = new Date(rig.clock.now.getTime() + 11 * 60_000)
    await expect(call(rig, 'CS_OAUTH_FINISH', { code: 'c', state, redirectUri: REDIRECT })).rejects.toThrow(/expired/)
    rig.clock.now = new Date(rig.clock.now.getTime() - 11 * 60_000)

    const state2 = await start(rig)
    rig.oauth.exchange = { ...rig.oauth.exchange, scope: 'openid email' }
    await expect(call(rig, 'CS_OAUTH_FINISH', { code: 'c', state: state2, redirectUri: REDIRECT })).rejects.toThrow(/read-only/)
    const state3 = await start(rig)
    rig.oauth.exchange = { ...rig.oauth.exchange, scope: 'gmail.readonly' }
    rig.oauth.identity = { email: 'ai4bcat@gmail.com', emailVerified: false, hd: null }
    await expect(call(rig, 'CS_OAUTH_FINISH', { code: 'c', state: state3, redirectUri: REDIRECT })).rejects.toThrow(/not verified/)
    expect(rig.oauth.tokens.size).toBe(0)
  })

  it('disconnect revokes and deletes the token and resets the mailbox', async () => {
    const rig = makeCsRig()
    rig.oauth.tokens.set(csUserId('m1'), { refreshToken: 'rt', scope: 's', googleEmail: 'ai4bcat@gmail.com', obtainedAt: 'x' })
    await call(rig, 'CS_DISCONNECT', { mailboxId: 'm1' })
    expect(rig.oauth.tokens.size).toBe(0)
    expect(rig.oauth.revoked).toEqual(['rt'])
    expect(rig.store.state.value.mailboxes.m1.status).toBe('NOT_CONNECTED')
  })
})

describe('simulated mailbox end to end (dev stack)', () => {
  const devRig = (): CsRig => makeCsRig({ dev: true, connected: false, cfg: { mailboxes: [] } })

  it('runs the real pipeline on injected fixtures with no model call, and files exactly the offer-bearing ones', async () => {
    const rig = devRig()
    await call(rig, 'CS_CONNECT_SIMULATED', { mailboxId: 'm1' })
    for (const f of CARRIER_INBOX_MAIL_FIXTURES) await call(rig, 'CS_SIM_INJECT_MAIL', { mailboxId: 'm1', fixtureId: f.id })

    let polls = 0
    for (let done = false; !done && polls < 15; polls += 1) done = (await call(rig, 'CS_POLL_NOW', { mailboxId: 'm1' })).done as boolean

    const dropped = CARRIER_INBOX_MAIL_FIXTURES.filter((f) => f.expect === 'STAGE1_DROP' || f.expect === 'STAGE2_DROP' || f.expect === 'NOT_RELEVANT')
    expect(rig.model.calls).toHaveLength(0)
    expect(rig.files.calls).toHaveLength(CARRIER_INBOX_MAIL_FIXTURES.length - dropped.length)
    // F11 is the same Message-ID as F1: one dedupe key.
    const keys = new Set(rig.files.calls.map((c) => c.sourceKey))
    expect(keys.size).toBe(rig.files.calls.length - 1)
    const f1 = rig.files.calls.find((c) => c.subject === 'Load ZZAL1001 - truck available')!
    expect(f1.extraction).toMatchObject({ kind: 'OFFER', rateCents: 185000, carrier: { mc: '9900001' } })
    const board = rig.files.calls.find((c) => c.boardProvider === 'DAT')!
    expect(board.extraction.flags).toContain('BOARD_RELAY')
    // The invoice reached the dev classification (NOT_RELEVANT) and was dropped, the newsletter never did.
    const state = rig.store.state.value
    expect(state.runs[0].stats).toBeTruthy()
    expect(Object.values(state.mailboxes)[0].historyId).not.toBeNull()
  })

  it('without a stored classification a simulated message goes to the model like any other', async () => {
    const rig = devRig()
    await call(rig, 'CS_CONNECT_SIMULATED', { mailboxId: 'm1' })
    const f1 = CARRIER_INBOX_MAIL_FIXTURES[0]
    await call(rig, 'CS_SIM_INJECT_MAIL', { mailboxId: 'm1', message: { ...f1.message, id: 'zz-al-raw' } })
    await call(rig, 'CS_POLL_NOW', {})
    expect(rig.model.calls).toHaveLength(1)
    expect(rig.files.calls).toHaveLength(1)
  })

  it('files an injected call fixture as a CALL and answers its replay as a duplicate', async () => {
    const rig = devRig()
    const [f16, f17] = CARRIER_INBOX_CALL_FIXTURES
    expect(await call(rig, 'CS_SIM_INJECT_CALL', { fixtureId: f16.id })).toEqual({ outcome: 'FILED' })
    expect(await call(rig, 'CS_SIM_INJECT_CALL', { fixtureId: f17.id })).toEqual({ outcome: 'DUPLICATE' })
    expect(rig.files.calls[0]).toMatchObject({ source: 'CALL', call: { callSid: f16.call.callSid } })
    expect(rig.model.calls).toHaveLength(0)
  })

  it('reset empties the simulated inbox and rewinds the cursor; purge removes only zz- objects', async () => {
    const rig = devRig()
    await call(rig, 'CS_CONNECT_SIMULATED', { mailboxId: 'm1' })
    await call(rig, 'CS_SIM_INJECT_MAIL', { mailboxId: 'm1', fixtureId: 'zz-al-f01' })
    await call(rig, 'CS_SIM_INJECT_MAIL', { mailboxId: 'm1', message: { id: 'keep-me', from: 'a@example.invalid', subject: 's', body: 'b' } })
    expect((await call(rig, 'CS_SIM_PURGE_TEST', { mailboxId: 'm1' })).deleted).toBe(1)
    expect([...rig.s3.map.keys()].some((k) => k.endsWith('keep-me.json'))).toBe(true)
    await call(rig, 'CS_SIM_RESET', {})
    expect(rig.s3.map.size).toBe(0)
    expect(rig.store.state.value.mailboxes.m1.historyId).toBeNull()
  })

  it('refuses a stored classification on a mailbox that is not simulated', async () => {
    const rig = makeCsRig({ dev: true, mailbox: MAILBOX })
    await expect(call(rig, 'CS_SIM_INJECT_MAIL', { mailboxId: 'm1', fixtureId: 'zz-al-f01' })).rejects.toThrow(/not simulated/)
  })

  it('the dev stack\'s classification is never honoured when the stack is not dev', async () => {
    const rig = makeCsRig({ dev: false, mailbox: { ...MAILBOX, mode: 'SIMULATED', addresses: ['loads@example.invalid'] } })
    const f1 = CARRIER_INBOX_MAIL_FIXTURES[0]
    await rig.deps.sim.inject(csUserId('m1'), { ...f1.message, devExtraction: { ...f1.devExtraction, rateDollars: 1 }, internalDate: String(rig.clock.now.getTime()) })
    await call(rig, 'CS_POLL_NOW', {})
    expect(rig.model.calls).toHaveLength(1)
    expect(rig.files.calls[0].extraction.rateCents).toBe(185000)
  })
})
