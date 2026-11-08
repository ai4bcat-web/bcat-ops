import type { AljexImportJob, EngineStore } from '../../../../src/types/tms'
import { DEFAULT_ALJEX_PROFILE, type AljexProfile } from '../../../../src/lib/aljex/profile'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A map of entries (objects), not the plain string map the UI profile body uses for the same key. */
const isEntryMap = (v: unknown): v is Record<string, Record<string, unknown>> =>
  isRecord(v) && Object.values(v).every(isRecord)

const isStringMap = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === 'string')

/**
 * Merge a persisted `AljexMappingProfile.profile` body over the defaults. Only keys whose value has
 * the engine's shape are taken (the UI body also carries string-valued maps under some of the same
 * names); `carrierWindow` and `dateWindow` are translated.
 */
export function mergeProfileBody(body: Record<string, unknown> | null | undefined, version = 1): AljexProfile {
  const out: AljexProfile = { ...structuredClone(DEFAULT_ALJEX_PROFILE), version }
  if (!body) return out
  const target = out as unknown as Record<string, unknown>
  for (const key of ['statusMap', 'typeMap', 'chargeDescriptionMap', 'projectedTypeMap'] as const) {
    if (isEntryMap(body[key])) target[key] = body[key]
  }
  for (const key of ['repMap', 'dispatcherMap', 'safetyRatingMap', 'stopMarkerMap'] as const) {
    if (isStringMap(body[key])) target[key] = body[key]
  }
  if (isRecord(body.paymentMethodByCheckShape)) target.paymentMethodByCheckShape = body.paymentMethodByCheckShape
  if (Array.isArray(body.divisionRules) && body.divisionRules.every((r) => isRecord(r) && typeof r.when === 'string')) target.divisionRules = body.divisionRules
  if (Array.isArray(body.ownerOperatorCarrierIds)) target.ownerOperatorCarrierIds = body.ownerOperatorCarrierIds.map(String)
  for (const key of ['fuelPattern', 'ownAssetCarrierMatch'] as const) if (typeof body[key] === 'string') target[key] = body[key]
  for (const key of ['carrierCutoffDate', 'unbilledLegacyBefore'] as const) if (typeof body[key] === 'string' || body[key] === null) target[key] = body[key]
  if (typeof body.carrierWindowMonths === 'number') out.carrierWindowMonths = body.carrierWindowMonths
  if (isRecord(body.carrierWindow)) {
    if (typeof body.carrierWindow.months === 'number') out.carrierWindowMonths = body.carrierWindow.months
    if (typeof body.carrierWindow.cutoffDate === 'string') out.carrierCutoffDate = body.carrierWindow.cutoffDate
  }
  const win = isRecord(body.window) ? body.window : isRecord(body.dateWindow) ? body.dateWindow : null
  if (win && typeof win.start === 'string' && typeof win.end === 'string') out.window = { start: win.start, end: win.end }
  return out
}

export interface LoadedProfile {
  profile: AljexProfile
  /** Values the owner explicitly accepted as "treat as the default" (UI `acceptedUnmapped`). */
  accepted: Set<string>
}

/** The persisted profile for the job's layout (defaults when none is saved), with the job's options layered on top. */
export async function loadProfile(store: EngineStore, job: AljexImportJob): Promise<LoadedProfile> {
  const layoutId = job.layoutId ?? DEFAULT_ALJEX_PROFILE.layoutId
  const [row] = await store.getMany('aljexMappingProfile', [layoutId])
  const body = row && isRecord(row.profile) ? row.profile : null
  const version = typeof row?.version === 'number' ? row.version : 1
  const profile = mergeProfileBody(body, version)
  profile.layoutId = layoutId
  const opts = job.options ?? {}
  if (typeof opts.carrierCutoffDate === 'string') profile.carrierCutoffDate = opts.carrierCutoffDate
  if (typeof opts.carrierWindowMonths === 'number') profile.carrierWindowMonths = opts.carrierWindowMonths
  if (typeof opts.unbilledLegacyBefore === 'string') profile.unbilledLegacyBefore = opts.unbilledLegacyBefore
  const accepted = new Set<string>(Array.isArray(body?.acceptedUnmapped) ? body.acceptedUnmapped.map(String) : [])
  return { profile, accepted }
}
