/**
 * Step AB §3.3 — per-field chips and rep edits. Same five states as Intake:
 * AUTO (green) · LOW (amber) · MISSING (red) · CONFIRMED (blue) · INVALID (red).
 * Pure; relative imports only.
 */
import type { SpotExtraction, SpotFieldMeta, SpotFieldMetaEntry } from '../../types/tms'
import { mapAccessorials } from './accessorials'
import {
  fieldValuePresent,
  missingRequired,
  normalizeIsoDate,
  normalizeState,
  normalizeWeight,
  normalizeZip,
  requestStatusFor,
} from './normalize'
import type { SpotFieldStatus } from './types'

export {
  fieldValuePresent,
  missingRequired,
  requestStatusFor,
  REQUIRED_SPOT_FIELDS,
  SPOT_FIELD_KEYS,
} from './normalize'

/**
 * The chip for one field. INVALID wins, then absent = MISSING, then a rep's own edit =
 * CONFIRMED, then low confidence/defaulted = LOW, else AUTO.
 */
export function fieldStatusOf(key: string, e: SpotExtraction, meta: SpotFieldMeta): SpotFieldStatus {
  const m = meta?.[key]
  if (m?.invalid) return 'INVALID'
  if (!fieldValuePresent(key, e)) return 'MISSING'
  if (m?.confirmed) return 'CONFIRMED'
  if (!m || m.confidence === 'low' || m.source === 'DEFAULT') return 'LOW'
  return 'AUTO'
}

const REP_ENTRY: SpotFieldMetaEntry = { source: 'REP', confidence: 'high', confirmed: true }

export interface RepPatchResult {
  extraction: SpotExtraction
  fieldMeta: SpotFieldMeta
  missingFields: string[]
  status: 'NEW' | 'NEEDS_INFO'
}

/**
 * Applies a rep's edit: every edited field becomes CONFIRMED (or INVALID when the new
 * value fails its validator and is dropped), `missingFields` is recomputed, and the
 * request status flips NEW ↔ NEEDS_INFO. Inputs are not mutated.
 */
export function applyRepPatch(
  e: SpotExtraction,
  meta: SpotFieldMeta,
  patch: Partial<SpotExtraction>,
): RepPatchResult {
  const next: SpotExtraction = { ...e }
  const nextMeta: SpotFieldMeta = { ...meta }
  const mark = (key: string, invalid: boolean) => {
    nextMeta[key] = invalid ? { source: 'REP', confidence: 'low', invalid: true } : { ...REP_ENTRY }
  }

  if (patch.stops !== undefined) {
    let originBad = false
    let destBad = false
    next.stops = patch.stops.map((s) => {
      const stateRaw = typeof s.state === 'string' && s.state.trim() ? s.state : null
      const zipRaw = typeof s.zip === 'string' && s.zip.trim() ? s.zip : null
      const state = normalizeState(stateRaw)
      const zip = normalizeZip(zipRaw)
      if ((stateRaw != null && state == null) || (zipRaw != null && zip == null)) {
        if (s.type === 'DELIVERY') destBad = true
        else originBad = true
      }
      return { ...s, state, zip }
    })
    mark('origin', originBad)
    mark('destination', destBad)
  }
  if (patch.equipmentType !== undefined) {
    next.equipmentType = patch.equipmentType
    mark('equipment', false)
  }
  if (patch.equipment !== undefined) next.equipment = patch.equipment
  for (const key of ['pickupDate', 'deliveryDate'] as const) {
    if (patch[key] === undefined) continue
    const raw = patch[key]
    const ok = raw == null ? null : normalizeIsoDate(raw, '')
    next[key] = ok
    mark(key, raw != null && raw !== '' && ok == null)
  }
  if (patch.weightLbs !== undefined) {
    const ok = patch.weightLbs == null ? null : normalizeWeight(patch.weightLbs)
    next.weightLbs = ok
    mark('weightLbs', patch.weightLbs != null && ok == null)
  }
  if (patch.accessorials !== undefined) {
    next.accessorials = mapAccessorials(patch.accessorials)
    mark('accessorials', false)
  }
  if (patch.commodity !== undefined) {
    next.commodity = patch.commodity
    mark('commodity', false)
  }
  if (patch.lengthFt !== undefined) {
    next.lengthFt = patch.lengthFt
    mark('lengthFt', false)
  }
  if (patch.mode !== undefined) {
    next.mode = patch.mode
    mark('mode', false)
  }
  for (const key of ['customerName', 'contactName', 'contactPhone', 'pieces', 'temperatureF', 'hazmat', 'targetRateDollars', 'notes'] as const) {
    if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key]
  }

  const missingFields = missingRequired(next, nextMeta)
  return { extraction: next, fieldMeta: nextMeta, missingFields, status: requestStatusFor(missingFields) }
}
