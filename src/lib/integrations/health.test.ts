import { describe, it, expect } from 'vitest'
import { badgeOf, healthFrom, isNeutered, modeOf } from './health'
import { descriptorOf } from './registry'
import type { IntegrationHealthStatus, IntegrationStatus } from './types'

const NOW = '2026-10-29T12:00:00.000Z'

describe('healthFrom', () => {
  it('calls a 2xx healthy', () => {
    expect(healthFrom({ kind: 'HTTP', statusCode: 200 }, NOW)).toEqual({
      status: 'OK',
      reason: 'OK',
      checkedAt: NOW,
    })
  })

  it('calls 401 and 403 bad credentials, and nothing else', () => {
    for (const statusCode of [401, 403]) {
      const health = healthFrom({ kind: 'HTTP', statusCode }, NOW)
      expect(health.status).toBe('INVALID_CREDENTIALS')
      expect(health.reason).toBe('INVALID_CREDENTIALS')
      expect(health.detail).toContain(String(statusCode))
    }
  })

  it('cannot tell from any other non-2xx, and keeps the code in the detail', () => {
    for (const statusCode of [404, 429, 500, 503]) {
      const health = healthFrom({ kind: 'HTTP', statusCode, message: 'upstream said no' }, NOW)
      expect(health.status, String(statusCode)).toBe('UNABLE_TO_VERIFY')
      expect(health.reason, String(statusCode)).toBe('PROVIDER_UNREACHABLE')
      expect(health.detail, String(statusCode)).toContain(String(statusCode))
    }
  })

  it('treats a timeout or DNS failure as unreachable, not as a wrong password', () => {
    const health = healthFrom({ kind: 'ERROR', errorName: 'AbortError', message: 'timed out after 10s' }, NOW)
    expect(health.status).toBe('UNABLE_TO_VERIFY')
    expect(health.reason).toBe('PROVIDER_UNREACHABLE')
    expect(health.detail).toBe('AbortError: timed out after 10s')
  })

  it('carries the caller’s reason when no call was made', () => {
    for (const reason of ['NO_CREDENTIALS', 'NEUTERED_ON_DEV', 'NO_VALIDATE_ENDPOINT', 'NOT_APPLICABLE', 'STUB'] as const) {
      const health = healthFrom({ kind: 'SKIPPED', reason }, NOW)
      expect(health.status, reason).toBe('UNABLE_TO_VERIFY')
      expect(health.reason, reason).toBe(reason)
    }
  })

  it('never calls a neutered dev secret invalid', () => {
    const health = healthFrom({ kind: 'SKIPPED', reason: 'NEUTERED_ON_DEV', message: 'SLACK_BOT_TOKEN' }, NOW)
    expect(health.status).not.toBe('OK')
    expect(health.status).not.toBe('INVALID_CREDENTIALS')
  })
})

describe('badgeOf', () => {
  const TONES = ['blue', 'green', 'orange', 'pink', 'purple', 'red', 'turquoise', 'gray']
  const base = { mode: 'STUB' as const }

  it('shows the five page states and uses only kit tones', () => {
    expect(badgeOf({ ...base, status: 'NOT_CONNECTED', health: 'UNKNOWN' })).toEqual({
      label: 'Not connected',
      tone: 'gray',
    })
    expect(badgeOf({ ...base, status: 'CONNECTED', health: 'OK', mode: 'LIVE' })).toEqual({
      label: 'Connected',
      tone: 'green',
    })
    expect(badgeOf({ ...base, status: 'CONNECTED', health: 'INVALID_CREDENTIALS' })).toEqual({
      label: 'Invalid credentials',
      tone: 'red',
    })
    expect(badgeOf({ ...base, status: 'CONNECTED', health: 'UNABLE_TO_VERIFY' })).toEqual({
      label: 'Unable to verify',
      tone: 'orange',
    })
    expect(badgeOf({ ...base, status: 'DISCONNECTED', health: 'OK' })).toEqual({
      label: 'Disconnected',
      tone: 'gray',
    })
  })

  it('calls a provider that just answered 200 connected, whatever the stored status says', () => {
    expect(badgeOf({ ...base, status: 'NOT_CONNECTED', health: 'OK', healthReason: 'OK' })).toEqual({
      label: 'Connected',
      tone: 'green',
    })
  })

  it('says what dev neutering and not-applicable actually mean', () => {
    expect(
      badgeOf({ ...base, status: 'CONNECTED', health: 'UNABLE_TO_VERIFY', healthReason: 'NEUTERED_ON_DEV' }),
    ).toEqual({ label: 'Live on main · neutered on dev', tone: 'orange' })
    expect(
      badgeOf({ ...base, status: 'NOT_CONNECTED', health: 'UNABLE_TO_VERIFY', healthReason: 'NOT_APPLICABLE' }),
    ).toEqual({ label: 'Not applicable', tone: 'orange' })
  })

  it('never invites anyone to connect a provider that cannot be connected', () => {
    expect(
      badgeOf({ ...base, status: 'NOT_CONNECTED', health: 'UNKNOWN', applicability: 'NOT_APPLICABLE' }),
    ).toEqual({ label: 'Not applicable', tone: 'orange' })
    expect(
      badgeOf({ ...base, status: 'NOT_CONNECTED', health: 'UNKNOWN', applicability: 'LIVE_CAPABLE' }),
    ).toEqual({ label: 'Not connected', tone: 'gray' })
  })

  it('never shows green on a status × health the page can hold', () => {
    const statuses: IntegrationStatus[] = ['NOT_CONNECTED', 'CONNECTED', 'DISCONNECTED']
    const healths: IntegrationHealthStatus[] = ['UNKNOWN', 'OK', 'INVALID_CREDENTIALS', 'UNABLE_TO_VERIFY']
    for (const status of statuses) {
      for (const health of healths) {
        const badge = badgeOf({ ...base, status, health })
        expect(TONES, `${status}/${health}`).toContain(badge.tone)
        expect(badge.label.trim(), `${status}/${health}`).not.toBe('')
        if (badge.tone === 'green') expect(health, `${status}/${health}`).toBe('OK')
      }
    }
  })
})

describe('isNeutered', () => {
  it('is the dev guard’s one literal and nothing else', () => {
    expect(isNeutered('disabled-on-dev')).toBe(true)
    expect(isNeutered('disabled-on-dev ')).toBe(false)
    expect(isNeutered('')).toBe(false)
    expect(isNeutered(null)).toBe(false)
  })
})

describe('modeOf', () => {
  const otr = descriptorOf('OTR')!
  const dat = descriptorOf('DAT')!
  const slack = descriptorOf('SLACK')!
  const gmail = descriptorOf('GMAIL')!
  const twilio = descriptorOf('TWILIO')!
  const convoy = descriptorOf('CONVOY')!
  const openapi = descriptorOf('OPENAPI')!

  const datCreds = {
    serviceAccountEmail: 'dat@bcatcorp.com',
    serviceAccountPassword: 'hunter2hunter2',
    rateViewTier: 'Combo Pro',
  }

  it('is LIVE only with every required credential', () => {
    const held = { OTR_USERNAME: 'bcat', OTR_PASSWORD: 'p', OTR_SUBSCRIPTION_KEY: 'k' }
    expect(modeOf(otr, held)).toBe('LIVE')
    expect(modeOf(otr, { ...held, OTR_SUBSCRIPTION_KEY: '' })).toBe('STUB')
    expect(modeOf(otr, {})).toBe('STUB')
  })

  it('is STUB for a fully credentialled provider nothing in this repo can call', () => {
    expect(modeOf(dat, datCreds)).toBe('STUB')
  })

  it('is STUB while a stack secret is neutered on dev', () => {
    const held = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_SIGNING_SECRET: 's', SLACK_CHANNEL_MAPPING: '{}' }
    expect(modeOf(slack, held)).toBe('LIVE')
    expect(modeOf(slack, { ...held, SLACK_BOT_TOKEN: 'disabled-on-dev' })).toBe('STUB')
  })

  it('is LIVE for a bridge only once something has actually arrived', () => {
    expect(modeOf(gmail, {})).toBe('STUB')
    expect(modeOf(gmail, {}, { bridgeSeen: true })).toBe('LIVE')
  })

  it('is STUB for a script-managed provider whose pool has no configuration', () => {
    expect(modeOf(twilio, {})).toBe('STUB')
    expect(modeOf(twilio, { TWILIO_ACCOUNT_SID: 'AC1' })).toBe('LIVE')
  })

  it('is always STUB for a not-applicable provider, and LIVE for BCAT’s own API', () => {
    expect(modeOf(convoy, { activationCode: 'anything' })).toBe('STUB')
    expect(modeOf(openapi, {})).toBe('LIVE')
  })
})
