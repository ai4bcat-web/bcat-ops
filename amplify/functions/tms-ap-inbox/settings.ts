/**
 * Step AG §5.1 — validated config writes. `resolveApInboxConfig` clamps silently (right for stored
 * data); a posted change is REFUSED instead, so a UI bug cannot quietly lower the 0.85 auto-apply
 * floor or save something the admin did not type.
 */
import { AUTO_APPLY_MIN_CEILING, AUTO_APPLY_MIN_FLOOR, resolveApInboxConfig } from '../../../src/lib/apInbox/constants'
import type { ApInboxConfig, ApInboxState } from '../../../src/lib/apInbox/types'
import type { ApInboxDeps } from './contract'

const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function whole(v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be a whole number between ${lo} and ${hi}`)
  return v
}

function score(v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`)
  const r = Math.round(v * 100) / 100
  if (r < lo - 1e-9 || r > hi + 1e-9) throw new Error(`${name} must be between ${lo.toFixed(2)} and ${hi.toFixed(2)}`)
  return r
}

/** Merge `patch` over `current`, refusing anything out of range; returns a fully resolved config. */
export function validateConfigPatch(
  patch: Record<string, unknown>,
  current: ApInboxConfig,
  o: { devStack: boolean; connection: ApInboxState['connection'] },
): ApInboxConfig {
  const m: ApInboxConfig = { ...current }
  const has = (k: keyof ApInboxConfig) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined
  if (has('enabled')) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be true or false')
    m.enabled = patch.enabled
  }
  if (has('autoApply')) {
    if (typeof patch.autoApply !== 'boolean') throw new Error('autoApply must be true or false')
    m.autoApply = patch.autoApply
  }
  if (has('mode')) {
    if (patch.mode !== 'GOOGLE' && patch.mode !== 'SIMULATED') throw new Error('mode must be GOOGLE or SIMULATED')
    m.mode = patch.mode
  }
  if (has('mailbox')) {
    if (typeof patch.mailbox !== 'string' || !MAILBOX.test(patch.mailbox.trim())) throw new Error('mailbox must be an e-mail address')
    m.mailbox = patch.mailbox.trim().toLowerCase()
  }
  if (has('runHourChicago')) m.runHourChicago = whole(patch.runHourChicago, 'runHourChicago', 0, 23)
  if (has('lookbackHours')) m.lookbackHours = whole(patch.lookbackHours, 'lookbackHours', 1, 168)
  if (has('maxMessagesPerRun')) m.maxMessagesPerRun = whole(patch.maxMessagesPerRun, 'maxMessagesPerRun', 1, 500)
  if (has('maxModelCallsPerRun')) m.maxModelCallsPerRun = whole(patch.maxModelCallsPerRun, 'maxModelCallsPerRun', 1, 300)
  if (has('maxAutoAppliesPerRun')) m.maxAutoAppliesPerRun = whole(patch.maxAutoAppliesPerRun, 'maxAutoAppliesPerRun', 0, 200)
  if (has('dismissedRetentionDays')) m.dismissedRetentionDays = whole(patch.dismissedRetentionDays, 'dismissedRetentionDays', 7, 365)
  if (has('resolvedRetentionDays')) m.resolvedRetentionDays = whole(patch.resolvedRetentionDays, 'resolvedRetentionDays', 7, 365)
  if (has('autoApplyMinScore')) m.autoApplyMinScore = score(patch.autoApplyMinScore, 'autoApplyMinScore', AUTO_APPLY_MIN_FLOOR, AUTO_APPLY_MIN_CEILING)
  if (has('reviewMinScore')) m.reviewMinScore = score(patch.reviewMinScore, 'reviewMinScore', 0.3, 0.99)
  // The review floor must sit at least 0.10 under the auto-apply score, whichever of the two moved.
  if (m.reviewMinScore > Math.round((m.autoApplyMinScore - 0.1) * 100) / 100 + 1e-9) {
    throw new Error(`reviewMinScore must be at most ${(Math.round((m.autoApplyMinScore - 0.1) * 100) / 100).toFixed(2)} (0.10 below autoApplyMinScore)`)
  }
  if (has('ignoreSenders')) {
    const raw = patch.ignoreSenders
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) throw new Error('ignoreSenders must be a list of addresses or domains')
    const list = [...new Set((raw as string[]).map((s) => s.trim().toLowerCase()).filter(Boolean))]
    if (list.length > 100) throw new Error('ignoreSenders holds at most 100 entries')
    m.ignoreSenders = list
  }

  const live = o.connection.status === 'CONNECTED' || o.connection.status === 'SIMULATED'
  if (m.mode === 'SIMULATED' && !o.devStack) throw new Error('The simulated mailbox is only available on the dev stack')
  if (m.mode !== current.mode && live) throw new Error('Disconnect the current mailbox before switching mode.')
  if (m.mailbox !== current.mailbox && o.connection.status === 'CONNECTED') throw new Error('Disconnect the mailbox before changing its address.')
  if (m.enabled) {
    const need = m.mode === 'SIMULATED' ? 'SIMULATED' : 'CONNECTED'
    if (o.connection.status !== need) {
      throw new Error(m.mode === 'SIMULATED' ? 'Use the simulated mailbox before switching the AP inbox on.' : 'Connect the Google account before switching the AP inbox on.')
    }
  }
  return resolveApInboxConfig(m)
}

/** CAS write of a partial change on top of the stored config (used by connect / disconnect, which cannot lose a race silently). */
export async function patchConfig(deps: Pick<ApInboxDeps, 'store'>, patch: Partial<ApInboxConfig>): Promise<ApInboxConfig> {
  for (let i = 0; i < 3; i += 1) {
    const cur = await deps.store.getConfig()
    if (await deps.store.putConfig(resolveApInboxConfig({ ...cur, ...patch }), cur.version)) return deps.store.getConfig()
  }
  throw new Error('Settings changed elsewhere — reload and try again.')
}
