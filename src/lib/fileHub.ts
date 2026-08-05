/**
 * The Files hub — one place to see and download everything on file for a driver or a
 * truck.
 *
 * This file defines only the SLOTS (what should exist). The documents themselves live
 * in ComplianceDocument, the same store used by Compliance, Onboarding, Driver Documents
 * and Asset Documents — so a CDL uploaded during onboarding shows up here automatically
 * and never needs uploading twice. That only holds because the `key`s below REUSE the
 * existing documentType keys:
 *
 *   cdl_copy, medical_card      ← src/lib/complianceRequirements.ts (driver onboarding)
 *   insurance_cert, irp_cab_card ← src/lib/truckDocs.ts (Asset Documents)
 *
 * Do NOT rename those keys — that would orphan every document already uploaded.
 * The truck photo keys are new to this hub.
 */

import { TRUCK_DOC_SPECS, evaluateTruckDoc } from './truckDocs'
import type { Equipment } from '@/types/equipment'
import type { ComplianceDocument } from '@/types'

export type FileSlotKind = 'document' | 'photo'

export interface FileSlot {
  key:   string
  label: string
  sub:   string
  kind:  FileSlotKind
  /** Slot is expected for every entity — a missing one counts against the ready score. */
  required: boolean
  /** Photos and plate shots don't expire; cab cards and CDLs do. */
  expires: boolean
}

// ── Driver ──────────────────────────────────────────────────────────────────────
// Phone, truck # and trailer # are fields on the Driver record, not documents; they're
// rendered from the record itself in the profile panel.

export const DRIVER_FILE_SLOTS: readonly FileSlot[] = [
  { key: 'cdl_copy',     label: 'CDL',              sub: 'Front and back',            kind: 'document', required: true,  expires: true },
  { key: 'medical_card', label: 'Medical card',     sub: "Examiner's certificate",    kind: 'document', required: true,  expires: true },
]

// ── Truck ───────────────────────────────────────────────────────────────────────
// VIN and plate number are fields on the Equipment record; the paperwork and photos
// are documents.
//
// DERIVED from TRUCK_DOC_SPECS rather than listed again here, so the Files hub and the
// Asset Documents page always show the identical set of truck documents — adding one to
// that catalog adds it to both pages at once, and they can never drift apart.

export const TRUCK_FILE_SLOTS: readonly FileSlot[] = TRUCK_DOC_SPECS.map((spec) => ({
  key:   spec.key,
  label: spec.label,
  sub:   spec.sub,
  kind:  spec.photo ? 'photo' : 'document',
  required: true,
  // Photos never expire. DOT carries a date, but it comes from the truck record
  // (Equipment.dotInspectionDate + fleet cadence), not from the document itself.
  expires: !spec.photo,
}))

export const slotsFor = (entityType: 'DRIVER' | 'TRUCK'): readonly FileSlot[] =>
  entityType === 'DRIVER' ? DRIVER_FILE_SLOTS : TRUCK_FILE_SLOTS

const ALL_SLOT_KEYS = new Set([...DRIVER_FILE_SLOTS, ...TRUCK_FILE_SLOTS].map((s) => s.key))

/** True for a documentType the hub has no slot for — shown under "Other documents". */
export const isUnslottedDoc = (documentType: string) => !ALL_SLOT_KEYS.has(documentType)

// ── Slot status ─────────────────────────────────────────────────────────────────

export type SlotState = 'MISSING' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'WAIVED'

export const EXPIRING_SOON_DAYS = 30

/** Days from `today` until `dateStr` (negative once past). */
export function daysUntil(dateStr: string, today = new Date()): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const target = Date.UTC(y, m - 1, d)
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target - now) / 86_400_000)
}

/**
 * A slot's state from its document's expiration (non-expiring docs are simply VALID).
 *
 * For TRUCKS prefer `truckSlotState`, which additionally honours the DOT inspection's
 * truck-sourced date and WAIVED markers exactly as the Asset Documents page does.
 */
export function slotState(
  doc: { expirationDate?: string | null; status?: string; s3Key?: string | null } | undefined,
  today = new Date(),
): SlotState {
  if (doc?.status === 'WAIVED') return 'WAIVED'
  if (!doc) return 'MISSING'
  if (!doc.expirationDate) return 'VALID'
  const days = daysUntil(doc.expirationDate, today)
  if (days < 0) return 'EXPIRED'
  if (days <= EXPIRING_SOON_DAYS) return 'EXPIRING_SOON'
  return 'VALID'
}

/**
 * Truck slot state, delegating to the same evaluator the Asset Documents page uses so
 * both pages report an identical status for the same truck + document. Handles the DOT
 * inspection (date from Equipment.dotInspectionDate, cadence by fleet) and WAIVED.
 */
export function truckSlotState(truck: Equipment, slotKey: string, doc?: ComplianceDocument): SlotState {
  const spec = TRUCK_DOC_SPECS.find((s) => s.key === slotKey)
  if (!spec) return slotState(doc)
  return evaluateTruckDoc(truck, spec, doc).state as SlotState
}

export interface ReadyScore {
  /** Required slots that have a document on file (any state). */
  onFile:   number
  required: number
  /** Required slots with nothing uploaded at all. */
  missing:  number
  /** Documents present but expired or expiring within 30 days. */
  attention: number
}

/**
 * The dots in the list row: how complete this entity's file is.
 *
 * Takes a state resolver rather than a document map so trucks can pass
 * `truckSlotState` (DOT + waived aware) and drivers the plain `slotState`.
 */
export function readyScore(
  slots: readonly FileSlot[],
  stateOf: (slotKey: string) => SlotState,
): ReadyScore {
  const required = slots.filter((s) => s.required)
  let onFile = 0, missing = 0, attention = 0
  for (const s of required) {
    const state = stateOf(s.key)
    // A waived document isn't outstanding and isn't a gap — it doesn't apply at all,
    // so it drops out of the denominator rather than counting as satisfied.
    if (state === 'WAIVED') continue
    if (state === 'MISSING') missing++
    else {
      onFile++
      if (state !== 'VALID') attention++
    }
  }
  return { onFile, required: onFile + missing, missing, attention }
}
