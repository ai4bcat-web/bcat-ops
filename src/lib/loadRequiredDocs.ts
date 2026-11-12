/**
 * Per-load required documents: what one load needs on top of the customer's (or the org
 * default) list. POD is always required and a rate confirmation is required once an outside
 * carrier hauls the load; those defaults are not stored per load and cannot be removed here.
 * What a load adds (a lumper receipt, a scale ticket) is stored on `Load.requiredDocTypes` and
 * blocks release like any other required document.
 *
 * Imports are relative: the shipment, finance and driver Lambdas bundle this file by path.
 */
import { DOCUMENT_TYPE_LABELS, normalizeRequiredDocTypes } from './shipmentDocuments'
import type { ShipmentDocumentType } from '../types/tms'

/** What may be ticked as an extra for one load. Internal paperwork (invoices, summaries) is not something a load "needs". */
export const LOAD_EXTRA_DOC_TYPES = [
  'BOL',
  'LUMPER_RECEIPT',
  'WEIGHT_TICKET',
  'TEMP_LOG',
  'INSPECTION_REPORT',
  'CUSTOMS',
  'PACKING_LIST',
  'PHOTO',
] as const satisfies readonly ShipmentDocumentType[]

/** The defaults every load carries (Ryne, 2026-11-12): POD always, the rate confirmation with an outside carrier. */
export const LOAD_DEFAULT_DOC_TYPES = ['POD', 'RATE_CON'] as const satisfies readonly ShipmentDocumentType[]

/** The documents a driver can be asked for. The rate confirmation is the office's to collect. */
export function isDriverDocType(type: string): boolean {
  return type !== 'RATE_CON'
}

/**
 * The type a driver may tag an 'Additional document' with: a known extra that a driver can
 * be asked for. Anything else (blank, 'OTHER', the rate confirmation, a typo) is null, so the
 * upload stays untyped for the office rather than counting toward the wrong requirement.
 */
export function driverAdditionalDocType(value: string | null | undefined): (typeof LOAD_EXTRA_DOC_TYPES)[number] | null {
  const type = (value ?? '').trim()
  return isExtraType(type) && isDriverDocType(type) ? type : null
}

function isExtraType(type: string): type is (typeof LOAD_EXTRA_DOC_TYPES)[number] {
  return (LOAD_EXTRA_DOC_TYPES as readonly string[]).includes(type)
}

/**
 * Validate what a person ticked for one load: known extra types only, order of the picker kept,
 * duplicates dropped. Throws on anything else so a typo never silently fails to gate.
 */
export function validateLoadRequiredDocTypes(value: unknown): ShipmentDocumentType[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('requiredDocTypes must be an array')
  const picked = new Set<string>()
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'string' || !isExtraType(raw.trim())) {
      throw new Error(`requiredDocTypes[${i}] must be one of ${LOAD_EXTRA_DOC_TYPES.join(', ')}`)
    }
    picked.add(raw.trim())
  }
  return LOAD_EXTRA_DOC_TYPES.filter((t) => picked.has(t))
}

/** The extras a set of loads asks for, in picker order. Unknown or stray values never gate. */
export function loadExtraDocTypes(loads: readonly { requiredDocTypes?: readonly (string | null)[] | null }[]): ShipmentDocumentType[] {
  const wanted = new Set<string>()
  for (const load of loads) {
    for (const type of normalizeRequiredDocTypes(load.requiredDocTypes ?? []).types) wanted.add(type)
  }
  return LOAD_EXTRA_DOC_TYPES.filter((t) => wanted.has(t))
}

/** Short labels for chips and the driver app ("Lumper receipt"). */
export function docTypeLabel(type: string): string {
  if (type === 'RATE_CON') return 'Rate confirmation (RC)'
  return DOCUMENT_TYPE_LABELS[type as ShipmentDocumentType] ?? type
}
