import { describe, expect, it, vi } from 'vitest'
import { AP_INBOX_ACTION_NAMES, AP_INBOX_ACTIONS } from '../../../src/lib/apInbox/actions'
import { ADMIN, AP_PAY, AP_TMS, makeItem, makeKit, NOBODY, NOW, OWNER } from './actionsTestkit'
import { dispatch } from './actions'

const runSync = vi.fn()
vi.mock('./sync', () => ({ runSync: (...a: unknown[]) => runSync(...a) }))

const call = (kit: ReturnType<typeof makeKit>, action: string, input: unknown, who = ADMIN) => dispatch(action, input, who, kit.deps)

describe('authorization matrix', () => {
  const identities = { nobody: NOBODY, pay: AP_PAY, tms: AP_TMS, admin: ADMIN, owner: OWNER }
  for (const name of AP_INBOX_ACTION_NAMES) {
    const who = AP_INBOX_ACTIONS[name].who
    it(`${name} (${who})`, async () => {
      for (const [label, id] of Object.entries(identities)) {
        const kit = makeKit({}, { devStack: true })
        const allowed = who === 'AP_USER' ? label !== 'nobody' : label === 'admin' || label === 'owner'
        const p = dispatch(name, { itemId: 'missing' }, id, kit.deps)
        if (allowed) {
          // Past the door: any failure is an input/domain error, never Forbidden/Unauthorized.
          await p.catch((e: Error) => expect(e.message).not.toMatch(/^(Forbidden|Unauthorized)/))
        } else {
          await expect(p).rejects.toThrow(/^Forbidden/)
        }
      }
    })
  }

  it('refuses a missing identity and an unknown action', async () => {
    const kit = makeKit()
    await expect(dispatch('AP_INBOX_STATUS', {}, null, kit.deps)).rejects.toThrow(/Unauthorized/)
    await expect(dispatch('AP_INBOX_NOPE', {}, ADMIN, kit.deps)).rejects.toThrow(/Unknown action/)
  })

  it('simulated-mailbox actions are refused off the dev stack, even for the owner', async () => {
    const kit = makeKit({}, { devStack: false })
    for (const a of ['AP_INBOX_CONNECT_SIMULATED', 'AP_INBOX_SIM_INJECT', 'AP_INBOX_SIM_RESET', 'AP_INBOX_SIM_PURGE_TEST']) {
      await expect(call(kit, a, {}, OWNER)).rejects.toThrow(/only available on the dev stack/)
    }
    expect(kit.fakes.injected).toHaveLength(0)
  })
})

describe('AP_INBOX_STATUS', () => {
  it('returns config, a connection view without the pending OAuth state, the open count and provider readiness', async () => {
    const kit = makeKit({ state: { connection: { status: 'PENDING', googleEmail: null, connectedAt: null, scopes: [], lastError: null, pendingState: 'ap.secret', pendingStateExp: 'x' } } })
    await kit.mem.store.putItemIfAbsent(makeItem())
    const s = (await call(kit, 'AP_INBOX_STATUS', {}, AP_PAY)) as Record<string, unknown>
    expect(s).toMatchObject({ openCount: 1, devStack: true, providerReady: true, lastRun: null })
    expect(JSON.stringify(s)).not.toContain('ap.secret')
    expect(JSON.stringify(s)).not.toContain('csecret')
  })
})

describe('AP_INBOX_SAVE_SETTINGS', () => {
  const save = (kit: ReturnType<typeof makeKit>, config: unknown, expectedVersion = 1) => call(kit, 'AP_INBOX_SAVE_SETTINGS', { config, expectedVersion })

  it('refuses an auto-apply score under the 0.85 floor and a review floor too close to it', async () => {
    const kit = makeKit()
    await expect(save(kit, { autoApplyMinScore: 0.8 })).rejects.toThrow(/autoApplyMinScore must be between 0.85/)
    await expect(save(kit, { autoApplyMinScore: 0.9, reviewMinScore: 0.85 })).rejects.toThrow(/reviewMinScore must be at most 0.80/)
    expect(kit.mem.getConfigNow().autoApplyMinScore).toBe(0.9)
  })

  it('saves a valid change under CAS and refuses a stale version', async () => {
    const kit = makeKit()
    const out = (await save(kit, { runHourChicago: 7, autoApply: false, ignoreSenders: [' Spam@X.com '] })) as { config: Record<string, unknown> }
    expect(out.config).toMatchObject({ runHourChicago: 7, autoApply: false, ignoreSenders: ['spam@x.com'], version: 2 })
    await expect(save(kit, { runHourChicago: 8 }, 1)).rejects.toThrow(/changed elsewhere/)
  })

  it('cannot switch on before a mailbox is connected, and SIMULATED is refused off dev', async () => {
    const kit = makeKit()
    await expect(save(kit, { enabled: true })).rejects.toThrow(/Connect the Google account/)
    const prod = makeKit({}, { devStack: false })
    await expect(save(prod, { mode: 'SIMULATED' })).rejects.toThrow(/dev stack/)
  })

  it('a non-admin AP user cannot save', async () => {
    await expect(call(makeKit(), 'AP_INBOX_SAVE_SETTINGS', { config: {}, expectedVersion: 1 }, AP_PAY)).rejects.toThrow(/^Forbidden/)
  })
})

describe('AP_INBOX_SYNC_NOW', () => {
  it('delegates one 20 s budgeted slice and passes done/remaining through', async () => {
    const kit = makeKit()
    runSync.mockResolvedValueOnce({ done: false, reviewed: 14, remaining: 6, digest: null })
    expect(await call(kit, 'AP_INBOX_SYNC_NOW', {}, AP_PAY)).toMatchObject({ done: false, reviewed: 14, remaining: 6 })
    expect(runSync).toHaveBeenLastCalledWith(kit.deps, { trigger: 'MANUAL', budgetMs: 20_000 })
  })

  it('off dev, a second press right after a finished manual run returns the cached digest without a new run', async () => {
    runSync.mockClear()
    const digest = { id: 'r1', trigger: 'MANUAL', startedAt: NOW.toISOString(), endedAt: new Date(NOW.getTime() - 30_000).toISOString(), reviewed: 9, partial: false }
    const kit = makeKit({ state: { runs: [digest as never] } }, { devStack: false })
    expect(await call(kit, 'AP_INBOX_SYNC_NOW', {}, AP_PAY)).toMatchObject({ done: true, cached: true, reviewed: 9 })
    expect(runSync).not.toHaveBeenCalled()
  })
})

describe('queue actions through the router', () => {
  it('PREVIEW_LINK shows the diff and the version, LINK applies it under that version, REVERT undoes it', async () => {
    const kit = makeKit()
    await kit.mem.store.putItemIfAbsent(makeItem())
    const target = { kind: 'CARRIER_BILL', id: 'bill-1' }
    const prev = (await call(kit, 'AP_INBOX_PREVIEW_LINK', { itemId: 'apin:m1', target }, AP_TMS)) as { plan: { changes: { field: string }[] }; version: number }
    expect(prev.plan.changes.map((c) => c.field)).toEqual(['billNumber', 'billDate', 'dueAt', 'billedCents'])
    const linked = (await call(kit, 'AP_INBOX_LINK', { itemId: 'apin:m1', target, picks: ['billNumber'], expectedVersion: prev.version }, AP_TMS)) as { item: { status: string }; fields: string[] }
    expect(linked.fields).toEqual(['billNumber'])
    expect(kit.mem.bills.get('bill-1')).toMatchObject({ billNumber: 'SH-5521', billDate: '2026-11-01' })
    await call(kit, 'AP_INBOX_REVERT', { itemId: 'apin:m1' }, AP_TMS)
    expect((kit.mem.bills.get('bill-1')!.billNumber ?? '').trim()).toBe('')
  })

  it('rejects bad payloads: unknown dismiss reason, bad target kind, malformed vendor amount', async () => {
    const kit = makeKit()
    await kit.mem.store.putItemIfAbsent(makeItem())
    await expect(call(kit, 'AP_INBOX_DISMISS', { itemId: 'apin:m1', reason: 'BECAUSE' })).rejects.toThrow(/reason must be one of/)
    await expect(call(kit, 'AP_INBOX_LINK', { itemId: 'apin:m1', target: { kind: 'ORDER', id: 'x' } })).rejects.toThrow(/target.kind/)
    await expect(call(kit, 'AP_INBOX_CREATE_VENDOR_BILL', { itemId: 'apin:m1', vendor: 'A', amountCents: 12.5 })).rejects.toThrow(/whole number of cents/)
    expect((await kit.mem.store.getItem('apin:m1'))!.status).toBe('NEEDS_REVIEW')
  })

  it('SIM_INJECT stamps the clock unless an internalDate is given and passes the dev extraction through', async () => {
    const kit = makeKit()
    await call(kit, 'AP_INBOX_SIM_INJECT', { message: { id: 'zz-1', from: 'a@b.co', subject: 's', body: 'b', devExtraction: { kind: 'INVOICE' }, attachments: [{ name: 'a.pdf', contentType: 'application/pdf', size: 3, dataBase64: 'QUJD' }] } })
    await call(kit, 'AP_INBOX_SIM_INJECT', { message: { id: 'zz-2', from: 'a@b.co', subject: 's', body: 'b', internalDate: '1762000000000' } })
    expect(kit.fakes.injected).toMatchObject([{ id: 'zz-1', internalDate: String(NOW.getTime()), devExtraction: { kind: 'INVOICE' } }, { id: 'zz-2', internalDate: '1762000000000' }])
  })
})

describe('OAuth connection', () => {
  const start = (kit: ReturnType<typeof makeKit>, redirectUri = 'https://dev.example.com/tms/rates/spot/callback') => call(kit, 'AP_INBOX_OAUTH_START', { redirectUri }) as Promise<{ url: string }>
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!
  const finish = (kit: ReturnType<typeof makeKit>, state: string) => call(kit, 'AP_INBOX_OAUTH_FINISH', { code: 'c', state, redirectUri: 'https://dev.example.com/tms/rates/spot/callback' })
  const refused = (kit: ReturnType<typeof makeKit>) => {
    expect(kit.fakes.tokens.size).toBe(0)
    expect(kit.mem.getStateNow().connection.status).not.toBe('CONNECTED')
  }

  it('connects: ap.-prefixed state, token stored only under ap-inbox, no token string in any stored row', async () => {
    const kit = makeKit()
    const { url } = await start(kit)
    expect(stateOf(url)).toMatch(/^ap\./)
    expect(url).toContain('login_hint=ai4bcat@gmail.com')
    expect(await finish(kit, stateOf(url))).toEqual({ connected: true })
    expect([...kit.fakes.tokens.keys()]).toEqual(['ap-inbox'])
    const st = kit.mem.getStateNow()
    expect(st.connection).toMatchObject({ status: 'CONNECTED', googleEmail: 'ai4bcat@gmail.com' })
    expect(st.connection.pendingState).toBeUndefined()
    expect(st.cursor!.afterMs).toBe(NOW.getTime() - 24 * 3_600_000)
    expect(JSON.stringify([st, kit.mem.getConfigNow(), kit.mem.audits])).not.toMatch(/rt-secret|csecret/)
  })

  it('refuses a non-allow-listed redirect and a missing Google client', async () => {
    const kit = makeKit()
    await expect(start(kit, 'https://evil.example.com/tms/rates/spot/callback')).rejects.toThrow(/redirect address is not allowed/)
    kit.fakes.client = null
    await expect(start(kit)).rejects.toThrow(/NOT_CONFIGURED/)
  })

  it('refuses a wrong state, a reused state and an expired state; nothing is stored', async () => {
    const kit = makeKit()
    const { url } = await start(kit)
    await expect(finish(kit, 'ap.forged')).rejects.toThrow(/not valid/)
    expect(await finish(kit, stateOf(url))).toEqual({ connected: true })
    kit.fakes.tokens.clear()
    await expect(finish(kit, stateOf(url))).rejects.toThrow(/not valid/)
    expect(kit.fakes.tokens.size).toBe(0)

    const late = makeKit()
    const s2 = stateOf((await start(late)).url)
    const at = late.mem.getStateNow()
    await late.deps.store.patchState({ connection: { ...at.connection, pendingStateExp: new Date(NOW.getTime() - 1).toISOString() } })
    await expect(finish(late, s2)).rejects.toThrow(/not valid/)
    refused(late)
  })

  it('refuses the wrong Google account, an unverified e-mail and a missing scope or refresh token — nothing written', async () => {
    for (const mutate of [
      (k: ReturnType<typeof makeKit>) => (k.fakes.idEmail = { email: 'someone@gmail.com', emailVerified: true }),
      (k: ReturnType<typeof makeKit>) => (k.fakes.idEmail = { email: 'ai4bcat@gmail.com', emailVerified: false }),
      (k: ReturnType<typeof makeKit>) => (k.fakes.scopesOk = false),
      (k: ReturnType<typeof makeKit>) => (k.fakes.exchange.refreshToken = null),
    ]) {
      const kit = makeKit()
      const s = stateOf((await start(kit)).url)
      mutate(kit)
      await expect(finish(kit, s)).rejects.toThrow()
      refused(kit)
    }
  })

  it('disconnect revokes and deletes the token, clears the cursor and switches the inbox off', async () => {
    const kit = makeKit()
    await finish(kit, stateOf((await start(kit)).url))
    await call(kit, 'AP_INBOX_SAVE_SETTINGS', { config: { enabled: true }, expectedVersion: 1 })
    await call(kit, 'AP_INBOX_OAUTH_DISCONNECT', {})
    expect(kit.fakes.tokens.size).toBe(0)
    expect(kit.fakes.revoked).toEqual(['rt-secret-1'])
    expect(kit.mem.getStateNow()).toMatchObject({ cursor: null, connection: { status: 'NOT_CONNECTED' } })
    expect(kit.mem.getConfigNow().enabled).toBe(false)
  })

  it('a reconnect after NEEDS_RECONNECT keeps the cursor so the gap is read', async () => {
    const kit = makeKit({ state: { cursor: { afterMs: 12345, boundaryIds: [] }, connection: { status: 'NEEDS_RECONNECT', googleEmail: 'ai4bcat@gmail.com', connectedAt: null, scopes: [], lastError: null } } })
    await finish(kit, stateOf((await start(kit)).url))
    expect(kit.mem.getStateNow().cursor!.afterMs).toBe(12345)
  })

  it('CONNECT_SIMULATED enables the simulated mailbox with the requested look-back', async () => {
    const kit = makeKit()
    await call(kit, 'AP_INBOX_CONNECT_SIMULATED', { lookbackHours: 48 })
    expect(kit.mem.getConfigNow()).toMatchObject({ mode: 'SIMULATED', enabled: true })
    expect(kit.mem.getStateNow()).toMatchObject({ connection: { status: 'SIMULATED' }, cursor: { afterMs: NOW.getTime() - 48 * 3_600_000 } })
  })
})
