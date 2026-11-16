/**
 * Where each What's missing item is fixed, in the shipment editor (Ryne 2026-11-16: "click that piece and have it take
 * you to that spot in the load so we can update it"). One map for every REQS item key (boardReqs.ts): a field to scroll
 * to and focus (`fieldKey`, with `fallbackKeys` tried when the first control is not on screen, e.g. no carrier is booked
 * yet), or the inline customer editor (`action: 'editCustomer'`) for what lives on the customer, not on the load.
 */
import { LABEL } from './labels'

export type MissingAction = 'editCustomer'

export interface MissingTarget {
  fieldKey: string
  /** Tried, in order, when `fieldKey` is not rendered. */
  fallbackKeys?: readonly string[]
  action?: MissingAction
  /** One plain line on what to do there. */
  hint: string
}

/** The control a factoring gap (a stop's city, state or ZIP) lives on. */
export const FACTOR_STOP_FIELD: Record<string, string> = {
  PICKUP_CITY: 'f-pickup-city',
  PICKUP_STATE: 'f-pickup-state',
  PICKUP_ZIP: 'f-pickup-zip',
  DELIVERY_CITY: 'f-consignee-city',
  DELIVERY_STATE: 'f-consignee-state',
  DELIVERY_ZIP: 'f-consignee-zip',
}

/** What a missing item points at; null for a key this map does not know (the caller keeps its own fallback). */
export function missingTargetOf(key: string, customerLinked: boolean): MissingTarget | null {
  if (key === 'salesRep') return { fieldKey: LABEL.roles.salesRepId.testId, hint: 'Pick the sales rep under Roles.' }
  if (key === 'revDivision') return { fieldKey: LABEL.shipping.revDivision.testId, hint: 'Set the division at the top of Shipping Requirements.' }
  if (key === 'customerRate') return { fieldKey: LABEL.rates.customerLhRate.testId, hint: 'Enter the customer rate under Rates.' }
  if (key === 'expense' || key === 'profit') {
    return {
      fieldKey: LABEL.rates.carrierLhRate.testId,
      fallbackKeys: [LABEL.carrier.cover.testId, LABEL.carrier.carrier.testId, LABEL.rates.customerLhRate.testId],
      hint: 'Enter the carrier cost under Rates, or book the carrier first.',
    }
  }
  if (key === 'po') return { fieldKey: LABEL.customer.refNo.testId, fallbackKeys: ['hdr-customer-ref'], hint: 'Enter the customer ref (PO) at the top.' }
  if (key.startsWith('doc:')) return { fieldKey: `card-documents-slot-${key.slice(4)}`, hint: 'Upload it in Documents below.' }
  if (key.startsWith('customer:') || key === 'factor:CUSTOMER_MC' || key === 'factor:BILLING_METHOD') {
    return customerLinked
      ? { fieldKey: '', action: 'editCustomer', hint: 'Edit it on the customer without leaving the load.' }
      : { fieldKey: 'f-customer-change', fallbackKeys: ['f-customer-link', 'hdr-customer'], hint: 'Link the customer first.' }
  }
  if (key.startsWith('factor:')) {
    const field = FACTOR_STOP_FIELD[key.slice(7)]
    if (field) return { fieldKey: field, hint: 'Fill it in on the stop.' }
  }
  return null
}
