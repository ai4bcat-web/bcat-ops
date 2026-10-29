/**
 * Step R cutover. Whether a shipment's customer is resolved to a record.
 *
 * A shipment may exist with only the operator's typed customer text: the legacy
 * entrypoints (the new-shipment form, the scheduler duplicate, factoring) often have
 * nothing else, and inventing a Customer record — or refusing to record the freight at
 * all — are both worse than saying "we do not know yet". `customerName` carries the
 * typed text verbatim; `customerId` is simply absent.
 *
 * Readiness is derived from `customerId` alone and NEVER from status. The backfill sets
 * a shipment's status from its stop clock, so an unresolved row can arrive already
 * DELIVERED; a rule written as "DRAFT means unresolved" would wave it straight through
 * to AR, where the customer lookup then dies on an id that was never there.
 *
 * Shared deliberately: the board, the detail header, the Lambda's refusals and the
 * release-gate input all have to agree on one answer to one question.
 */

/** The shape every caller has in hand — Shipment, Order, or a board row built from one. */
export interface CustomerResolvable {
  customerId?: string | null
  customerName?: string | null
}

/**
 * True when no Customer record is linked. Blank and whitespace count as unresolved:
 * an empty string is not an id, and a sparse index would not carry it anyway.
 */
export function isCustomerUnresolved(row: CustomerResolvable | null | undefined): boolean {
  return !((row?.customerId ?? '').trim())
}

/** The label the board and the detail header show in place of a customer. */
export const UNRESOLVED_CUSTOMER_LABEL = 'Customer not linked'

/**
 * What to show where a customer name goes. The typed text when there is one — it is
 * what the operator actually wrote and the only honest thing to print — and the label
 * when the row carries nothing at all.
 */
export function customerDisplayName(row: CustomerResolvable | null | undefined): string {
  const typed = (row?.customerName ?? '').trim()
  if (typed) return typed
  return UNRESOLVED_CUSTOMER_LABEL
}

/**
 * The refusal an action returns when it needs a customer record and the shipment has
 * none. Named so the operator knows the next move is to link one, not to retry.
 */
export function unresolvedCustomerMessage(
  row: CustomerResolvable | null | undefined,
  what: string,
): string {
  const typed = (row?.customerName ?? '').trim()
  const who = typed ? `“${typed}”` : 'its customer'
  return `This shipment has no customer record linked — ${who} was never matched. Link a customer before ${what}.`
}
