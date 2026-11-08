import { describe, it, expect } from 'vitest'
import { descriptorOf, liveCapabilitiesOf } from '@/lib/integrations/registry'
import type { IntegrationRecord } from '@/lib/integrations/types'
import { deploymentSecretStatuses, secretSetCommand } from './deploymentSecrets'

const row = (provider: string, patch: Partial<IntegrationRecord> = {}): IntegrationRecord => ({
  id: provider, provider, kind: 'PROVIDER', mode: 'STUB', credentialSource: 'STACK', status: 'NOT_CONNECTED', health: 'UNKNOWN', ...patch,
})
const state = (byKey: Record<string, IntegrationRecord>, name: string) =>
  deploymentSecretStatuses(byKey).find((s) => s.name === name)!

describe('deploymentSecretStatuses', () => {
  it('reports Amplify secrets present or missing from the Lambda list, by name', () => {
    const byKey = { GOOGLE_MAPS: row('GOOGLE_MAPS', { missingCredentials: ['GEOCODE_TOKEN_SECRET'] }) }
    expect(state(byKey, 'GOOGLE_MAPS_API_KEY').state).toBe('PRESENT')
    const geo = state(byKey, 'GEOCODE_TOKEN_SECRET')
    expect(geo.state).toBe('MISSING')
    expect(geo.action).toBe(secretSetCommand('GEOCODE_TOKEN_SECRET'))
  })

  it('never guesses: no row or no reported list is "unknown", not present', () => {
    expect(state({}, 'GOOGLE_MAPS_API_KEY').state).toBe('UNKNOWN')
    expect(state({ GOOGLE_MAPS: row('GOOGLE_MAPS') }, 'GEOCODE_TOKEN_SECRET').state).toBe('UNKNOWN')
  })

  it('marks a dev-pinned secret as neutered, not present', () => {
    const byKey = { GOOGLE_MAPS: row('GOOGLE_MAPS', { missingCredentials: ['GOOGLE_MAPS_API_KEY'], healthReason: 'NEUTERED_ON_DEV' }) }
    expect(state(byKey, 'GOOGLE_MAPS_API_KEY').state).toBe('NEUTERED')
  })

  it('lists the page-entered DAT and MCP credentials still missing', () => {
    const byKey = {
      DAT: row('DAT', { credentialSource: 'PAGE', missingCredentials: ['Service account e-mail'] }),
      MYCARRIERPACKETS: row('MYCARRIERPACKETS', { credentialSource: 'PAGE', missingCredentials: [] }),
    }
    expect(state(byKey, 'DAT')).toMatchObject({ state: 'MISSING', missing: ['Service account e-mail'] })
    expect(state(byKey, 'MYCARRIERPACKETS').state).toBe('PRESENT')
  })
})

describe('registry: the secrets the card names', () => {
  it('the geocode signing secret is asked of the Lambda, and DAT stays a stub with no live capability', () => {
    expect(descriptorOf('GOOGLE_MAPS')!.stackSecretNames).toContain('GEOCODE_TOKEN_SECRET')
    expect(liveCapabilitiesOf(descriptorOf('DAT')!)).toEqual([])
  })
})
