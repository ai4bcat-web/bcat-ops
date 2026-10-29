/**
 * Step J — how a validate outcome becomes health, a badge and a mode.
 *
 * Three rules this file exists to hold in one place:
 *  - a 401 or 403 is bad credentials; anything else that is not a 2xx is "could not
 *    tell", never "wrong password";
 *  - a stack secret the dev guard pinned to `disabled-on-dev` is neutered, not
 *    invalid — the badge says "Live on main · neutered on dev" and never CONNECTED;
 *  - a provider with no credential is STUB, and a stub never claims to be live.
 */
import { liveCapabilitiesOf } from './registry'
import type {
  Health,
  IntegrationBadge,
  IntegrationHealthReason,
  IntegrationHealthStatus,
  IntegrationMode,
  IntegrationStatus,
  ProviderDescriptor,
} from './types'

/** What the one read call did. `SKIPPED` means no call was made, and says why. */
export interface ValidateOutcome {
  kind: 'HTTP' | 'ERROR' | 'SKIPPED'
  statusCode?: number
  errorName?: string
  message?: string
  reason?: IntegrationHealthReason
}

/** The literal the dev stack guard writes over every neutered secret. */
const NEUTERED_VALUE = 'disabled-on-dev'

export function healthFrom(outcome: ValidateOutcome, now: string): Health {
  if (outcome.kind === 'SKIPPED') {
    return {
      status: 'UNABLE_TO_VERIFY',
      reason: outcome.reason ?? 'NO_VALIDATE_ENDPOINT',
      ...(outcome.message ? { detail: outcome.message } : {}),
      checkedAt: now,
    }
  }

  if (outcome.kind === 'ERROR') {
    const name = outcome.errorName ?? 'Error'
    return {
      status: 'UNABLE_TO_VERIFY',
      reason: 'PROVIDER_UNREACHABLE',
      detail: outcome.message ? `${name}: ${outcome.message}` : name,
      checkedAt: now,
    }
  }

  const code = outcome.statusCode ?? 0
  if (code >= 200 && code < 300) {
    return {
      status: 'OK',
      reason: 'OK',
      ...(outcome.message ? { detail: outcome.message } : {}),
      checkedAt: now,
    }
  }
  if (code === 401 || code === 403) {
    return {
      status: 'INVALID_CREDENTIALS',
      reason: 'INVALID_CREDENTIALS',
      detail: outcome.message ? `HTTP ${code}: ${outcome.message}` : `HTTP ${code}`,
      checkedAt: now,
    }
  }
  return {
    status: 'UNABLE_TO_VERIFY',
    reason: 'PROVIDER_UNREACHABLE',
    detail: outcome.message ? `HTTP ${code}: ${outcome.message}` : `HTTP ${code}`,
    checkedAt: now,
  }
}

/**
 * The state badge: `status` × `health`, in the kit's own tones and nothing else.
 * Health outranks status: a row that answered 200 a second ago is connected whatever
 * the stored status says (a STACK provider is never "connected" by a credential form),
 * and a connected row whose key stopped working must not keep showing green.
 */
export function badgeOf(row: {
  status: IntegrationStatus
  health: IntegrationHealthStatus
  healthReason?: IntegrationHealthReason | null
  mode: IntegrationMode
}): IntegrationBadge {
  if (row.status === 'DISCONNECTED') return { label: 'Disconnected', tone: 'gray' }
  if (row.health === 'OK') return { label: 'Connected', tone: 'green' }
  if (row.health === 'INVALID_CREDENTIALS') return { label: 'Invalid credentials', tone: 'red' }
  if (row.health === 'UNABLE_TO_VERIFY') {
    if (row.healthReason === 'NEUTERED_ON_DEV') return { label: 'Live on main · neutered on dev', tone: 'orange' }
    if (row.healthReason === 'NOT_APPLICABLE') return { label: 'Not applicable', tone: 'orange' }
    return { label: 'Unable to verify', tone: 'orange' }
  }
  if (row.status === 'CONNECTED') return { label: 'Not checked', tone: 'gray' }
  return { label: 'Not connected', tone: 'gray' }
}

/** The dev stack pins a neutered secret to one literal; nothing else counts. */
export function isNeutered(value: string | null | undefined): boolean {
  return value === NEUTERED_VALUE
}

/** The credential names a source must hold before anything live can be attempted. */
function requiredKeysOf(d: ProviderDescriptor): string[] {
  if (d.credentialSource === 'PAGE') return d.credentialFields.filter((f) => !f.optional).map((f) => f.key)
  if (d.credentialSource === 'STACK') return d.stackSecretNames
  return []
}

/**
 * LIVE only when there is really something to call *and* something that can do the
 * calling: a credential in SSM does not make a DAT post exist, so a provider with no
 * live capability in this repo stays STUB however complete its credentials are.
 * Otherwise: every required credential present and none neutered, a bridge that has
 * actually received something, or BCAT's own API.
 */
export function modeOf(
  d: ProviderDescriptor,
  creds: Record<string, string | null | undefined>,
  opts?: { bridgeSeen?: boolean },
): IntegrationMode {
  if (d.applicability === 'NOT_APPLICABLE') return 'STUB'
  if (liveCapabilitiesOf(d).length === 0) return 'STUB'
  if (d.credentialSource === 'NONE') return 'STUB'
  if (d.credentialSource === 'BRIDGE') return opts?.bridgeSeen ? 'LIVE' : 'STUB'
  if (d.credentialSource === 'OWN') return 'LIVE'

  const values = Object.values(creds).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (values.some(isNeutered)) return 'STUB'

  if (d.credentialSource === 'SCRIPT') {
    // The script writes the whole parameter set or none of it; the registry does not
    // name those keys, so one real value is the evidence that the script has run.
    return values.length > 0 ? 'LIVE' : 'STUB'
  }

  const required = requiredKeysOf(d)
  if (required.length === 0) return 'STUB'
  const present = required.every((key) => {
    const value = creds[key]
    return typeof value === 'string' && value.trim() !== '' && !isNeutered(value)
  })
  return present ? 'LIVE' : 'STUB'
}
