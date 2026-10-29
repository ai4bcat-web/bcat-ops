import { describe, it, expect } from 'vitest'
import {
  CATEGORIES,
  PROVIDERS,
  PROVIDER_KEYS,
  credentialFieldsOf,
  descriptorOf,
  isApplicable,
  liveCapabilitiesOf,
  missingCredentials,
} from './registry'
import { stubAdapter } from './adapter'
import type { Adapter, ProviderKey } from './types'

/** Spec §8.1 in its own order, then the providers this stack already calls. */
const EXPECTED: ProviderKey[] = [
  'DAT',
  'TRUCKSTOP',
  'PARADE',
  'TRUCKER_TOOLS',
  'MACROPOINT',
  'LOAD_MARKET',
  'CONVOY',
  'PROJECT44',
  'HIGHWAY',
  'MYCARRIERPACKETS',
  'RMIS',
  'LOADBOARD_NETWORK',
  'FREIGHTLINK',
  'GREENSCREENS',
  'HAULPAY',
  'DENIM',
  'ARTISPAY',
  'TRIUMPH',
  'QUICKBOOKS_ONLINE',
  'QUICKBOOKS_DESKTOP',
  'SAGE50',
  'WEX_EFS',
  'LOADSURE',
  'SEVEN_L',
  'SMC3',
  'OPENAPI',
  'ORDERFUL',
  'GMAIL',
  'OUTLOOK',
  'HUBSPOT',
  'OTR',
  'MOTIVE',
  'BLUE_INK',
  'GOOGLE_MAPS',
  'ANTHROPIC',
  'SLACK',
  'TWILIO',
  'PAYCHEX',
  'JOBSDONE',
]

describe('PROVIDERS', () => {
  it('carries every provider exactly once, in spec order', () => {
    expect(PROVIDER_KEYS).toEqual(EXPECTED)
    expect(new Set(PROVIDER_KEYS).size).toBe(PROVIDER_KEYS.length)
  })

  it('claims a live capability only where something in this repo implements it', () => {
    for (const d of PROVIDERS) {
      const live = liveCapabilitiesOf(d)
      for (const capability of live) {
        expect(d.capabilities, `${d.key}.${capability}`).toContain(capability)
      }
      if (!d.liveCapabilities) {
        expect(live, d.key).toEqual(d.validateHow.liveCheck ? ['validate'] : [])
      }
    }
  })

  it('leaves the providers nothing can call today without a live capability', () => {
    for (const key of ['DAT', 'TRUCKSTOP', 'PARADE', 'TRUCKER_TOOLS', 'MACROPOINT', 'HAULPAY', 'DENIM', 'ARTISPAY']) {
      expect(liveCapabilitiesOf(descriptorOf(key)!), key).toEqual([])
    }
    expect(liveCapabilitiesOf(descriptorOf('OTR')!)).toContain('factor')
  })

  it('gives every not-applicable provider a reason and no live check', () => {
    const notApplicable = PROVIDERS.filter((d) => !isApplicable(d)).map((d) => d.key)
    expect(notApplicable).toEqual(['CONVOY', 'FREIGHTLINK', 'TRIUMPH', 'QUICKBOOKS_DESKTOP', 'SAGE50'])
    for (const d of PROVIDERS) {
      if (d.applicability === 'NOT_APPLICABLE') {
        expect(d.notApplicableReason?.trim(), d.key).toBeTruthy()
        expect(d.validateHow.liveCheck, d.key).toBeUndefined()
      }
    }
  })

  it('implements every capability it declares, and no other', () => {
    const method: Record<string, keyof Adapter> = {
      connect: 'connect',
      validate: 'validate',
      post: 'post',
      track: 'track',
      quote: 'quote',
      factor: 'factor',
      sync: 'sync',
    }
    for (const d of PROVIDERS) {
      const adapter = stubAdapter(d)
      expect(d.capabilities.length, d.key).toBeGreaterThan(0)
      for (const capability of d.capabilities) {
        expect(typeof adapter[method[capability]], `${d.key}.${capability}`).toBe('function')
      }
      for (const [capability, name] of Object.entries(method)) {
        if (capability === 'validate') continue
        if (!d.capabilities.includes(capability as never)) {
          expect(adapter[name], `${d.key}.${capability}`).toBeUndefined()
        }
      }
    }
  })

  it('files every provider under a category the index page can show', () => {
    const known = CATEGORIES.map((c) => c.key)
    for (const d of PROVIDERS) expect(known, d.key).toContain(d.category)
  })

  it('asks for credentials only where the page is allowed to take them', () => {
    for (const d of PROVIDERS) {
      if (d.credentialSource === 'STACK') {
        expect(d.stackSecretNames.length, d.key).toBeGreaterThan(0)
        expect(credentialFieldsOf(d), d.key).toEqual([])
      }
      if (d.credentialSource === 'PAGE') {
        expect(d.credentialFields.length, d.key).toBeGreaterThan(0)
        expect(d.stackSecretNames, d.key).toEqual([])
      }
    }
  })
})

describe('descriptorOf', () => {
  it('answers null for a row that is not a provider', () => {
    expect(descriptorOf('api:7f3c')).toBeNull()
    expect(descriptorOf('')).toBeNull()
    expect(descriptorOf('DAT')?.label).toBe('DAT')
  })
})

describe('missingCredentials', () => {
  const dat = descriptorOf('DAT')!
  const mcp = descriptorOf('MYCARRIERPACKETS')!
  const rmis = descriptorOf('RMIS')!
  const otr = descriptorOf('OTR')!

  it('lists the page fields nothing is stored for', () => {
    expect(missingCredentials(dat, null)).toEqual([
      'Service account e-mail',
      'Service account password',
      'RateView subscription',
    ])
    expect(missingCredentials(dat, [{ key: 'serviceAccountEmail', last4: 'corp' }])).toEqual([
      'Service account password',
      'RateView subscription',
    ])
  })

  it('counts a webhook signing secret as missing where nothing inbound can be verified without it', () => {
    const stored = [
      { key: 'username', last4: 'ryne' },
      { key: 'password', last4: '9d21' },
    ]
    expect(missingCredentials(mcp, stored)).toEqual(['Webhook signing secret'])
  })

  it('does not demand an optional field', () => {
    const stored = [
      { key: 'clientId', last4: 'bcat' },
      { key: 'clientPassword', last4: '4471' },
    ]
    expect(missingCredentials(rmis, stored)).toEqual([])
  })

  it('names the stack secrets the stack does not hold, and guesses nothing in the browser', () => {
    expect(missingCredentials(otr, null)).toEqual([])
    expect(
      missingCredentials(otr, null, { OTR_USERNAME: true, OTR_PASSWORD: false }),
    ).toEqual(['OTR_PASSWORD', 'OTR_SUBSCRIPTION_KEY'])
    expect(
      missingCredentials(otr, null, {
        OTR_USERNAME: true,
        OTR_PASSWORD: true,
        OTR_SUBSCRIPTION_KEY: true,
      }),
    ).toEqual([])
  })

  it('asks nothing of a bridge, a script, a not-applicable row or BCAT’s own API', () => {
    for (const key of ['GMAIL', 'TWILIO', 'CONVOY', 'OPENAPI']) {
      expect(missingCredentials(descriptorOf(key)!, null, {}), key).toEqual([])
    }
  })
})
