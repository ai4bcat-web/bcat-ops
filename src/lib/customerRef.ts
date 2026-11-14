/**
 * The shipment's Customer Ref: the number the customer calls the load by, and the PO it is invoiced and factored under.
 *
 * It lives in one of three places, depending on how the shipment was made:
 *   1. a PO reference on the order — the shipment form's Customer Ref header writes this (code PO);
 *   2. a CUSTOMER_REF reference on the order — the Aljex import's "Customer ref #";
 *   3. only on the load, as `tmsId` — the form mirrors the header there, and loads wrapped into shipments by the
 *      backfill (14934) or created before the header wrote a reference (20000) carry it nowhere else.
 * This reads them in that order, so every page that shows, searches or sends the Customer Ref agrees.
 * Only references the customer may see count. Pure and import-free: the Lambdas bundle it by relative path.
 */

export interface CustomerRefReference {
  code?: string | null
  value?: string | null
  level?: string | null
  visibility?: string | null
}

const PO_CODES = new Set(['PO', 'PO_NUMBER', 'CUSTOMER_PO'])
const CUSTOMER_REF_CODES = new Set(['CUSTOMER_REF'])

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.toUpperCase() !== 'N/A' ? t : null
}

function firstVisible(references: readonly CustomerRefReference[] | null | undefined, codes: Set<string>): string | null {
  for (const ref of references ?? []) {
    if (ref.level === 'STOP') continue
    if (ref.visibility === 'INTERNAL' || ref.visibility === 'CARRIER') continue
    if (!codes.has(String(ref.code ?? '').trim().toUpperCase())) continue
    const value = text(ref.value)
    if (value) return value
  }
  return null
}

/** The PO reference alone (code PO and its aliases), as the invoice states it. */
export function poReferenceOf(references: readonly CustomerRefReference[] | null | undefined): string | null {
  return firstVisible(references, PO_CODES)
}

/** PO reference, then CUSTOMER_REF reference, then the load's `tmsId`. Null when none holds a value. */
export function customerRefOf(
  references: readonly CustomerRefReference[] | null | undefined,
  loadTmsId?: string | null,
): string | null {
  return firstVisible(references, PO_CODES) ?? firstVisible(references, CUSTOMER_REF_CODES) ?? text(loadTmsId)
}
