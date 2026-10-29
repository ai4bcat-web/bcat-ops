import { describe, it, expect } from 'vitest'
import { adapterFor, stubAdapter } from './adapter'
import { PROVIDERS, descriptorOf } from './registry'
import type { Adapter, AdapterContext, ProviderDescriptor } from './types'

const ctxFor = (d: ProviderDescriptor, credentials: Record<string, string> = {}): AdapterContext => ({
  provider: d.key,
  credentials,
  settings: {},
  now: '2026-10-29T12:00:00.000Z',
})

const dat = descriptorOf('DAT')!
const otr = descriptorOf('OTR')!
const convoy = descriptorOf('CONVOY')!

const liveMarker: Adapter = {
  validate: async () => ({ status: 'OK', reason: 'OK', checkedAt: '2026-10-29T12:00:00.000Z' }),
  post: async () => ({ mode: 'LIVE', ok: true, message: 'posted', externalId: 'dat-88421' }),
}

describe('stubAdapter', () => {
  it('says STUB, says what a live call would have done, and never mints a plausible id', async () => {
    for (const d of PROVIDERS) {
      const adapter = stubAdapter(d)
      for (const capability of d.capabilities) {
        if (capability === 'validate') continue
        const run = adapter[capability]
        const result = await run!(ctxFor(d), { sample: true })
        expect(result.mode, d.key).toBe('STUB')
        expect(result.ok, d.key).toBe(true)
        expect(result.message.startsWith('STUB — '), `${d.key}.${capability}: ${result.message}`).toBe(true)
        expect(result.message, d.key).toContain(d.label)
        expect(result.externalId?.startsWith('stub:'), d.key).toBe(true)
        expect(result.detail, d.key).toMatchObject({ provider: d.key, capability, sample: { sample: true } })
      }
    }
  })

  it('never answers CONNECTED, whatever the provider', async () => {
    for (const d of PROVIDERS) {
      const health = await stubAdapter(d).validate(ctxFor(d))
      expect(health.status, d.key).toBe('UNABLE_TO_VERIFY')
      expect(health.reason, d.key).toBe(d.applicability === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'NO_CREDENTIALS')
      expect(health.checkedAt, d.key).toBe('2026-10-29T12:00:00.000Z')
    }
  })

  it('prints the not-applicable reason instead of pretending a call failed', async () => {
    const health = await stubAdapter(convoy).validate(ctxFor(convoy))
    expect(health.detail).toContain('ceased operations in 2023')
  })

  it('gives each run its own id', async () => {
    const adapter = stubAdapter(dat)
    const first = await adapter.post!(ctxFor(dat), {})
    const second = await adapter.post!(ctxFor(dat), {})
    expect(first.externalId).not.toBe(second.externalId)
  })
})

describe('adapterFor', () => {
  const otrCreds = { OTR_USERNAME: 'bcat', OTR_PASSWORD: 'hunter2hunter2', OTR_SUBSCRIPTION_KEY: 'sub-key-1' }
  const datCreds = {
    serviceAccountEmail: 'dat@bcatcorp.com',
    serviceAccountPassword: 'hunter2hunter2',
    rateViewTier: 'Combo Pro',
  }

  it('uses the live adapter only when every required credential is really there', async () => {
    expect(adapterFor(otr, otrCreds, liveMarker)).toBe(liveMarker)

    const { OTR_PASSWORD: _dropped, ...partial } = otrCreds
    const health = await adapterFor(otr, partial, liveMarker).validate(ctxFor(otr))
    expect(health.status).toBe('UNABLE_TO_VERIFY')
  })

  it('falls back to the stub when a credential is neutered on dev', async () => {
    const neutered = { ...otrCreds, OTR_PASSWORD: 'disabled-on-dev' }
    const health = await adapterFor(otr, neutered, liveMarker).validate(ctxFor(otr))
    expect(health.status).toBe('UNABLE_TO_VERIFY')
  })

  it('stays on the stub for a provider nothing in this repo can call, credentials or not', async () => {
    const result = await adapterFor(dat, datCreds, liveMarker).post!(ctxFor(dat), {})
    expect(result.mode).toBe('STUB')
  })

  it('falls back to the stub when no live adapter was supplied at all', async () => {
    const health = await adapterFor(otr, otrCreds).validate(ctxFor(otr))
    expect(health.status).toBe('UNABLE_TO_VERIFY')
  })

  it('refuses to go live for a provider that cannot be live', async () => {
    const result = await adapterFor(convoy, { anything: 'present' }, liveMarker).post!(ctxFor(convoy), {})
    expect(result.mode).toBe('STUB')
  })
})
