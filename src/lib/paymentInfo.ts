/**
 * Whether a payee can actually be paid by the method chosen for it (Ryne 2026-11-19: "flag carriers or factors that
 * don't have bank info and not let us pay them from selected if the info is missing").
 *
 * One rule, read by the AP board (chips, the worklist, the disabled Record payment buttons) and by tms-finance-actions
 * (Record payment refuses the bills it fails), so the screen and the server can never disagree.
 *
 * Per method, the least that must be on file:
 *   ACH          the full routing and account numbers (the encrypted mark the Chase file reads)
 *   WIRE, EFT    the last four of the account (the app never holds full wire numbers)
 *   CHECK        a complete remit-to address: street, city, state and ZIP
 *   ZELLE, VENMO the contact the money is sent to (the payee e-mail on the method)
 *   CARD         nothing: the card is entered on the terminal, and the app refuses to keep a card number
 * No method at all is `NO_PAYEE`. Nothing here reads a bank number, only whether one is on file.
 */

export type PaymentInfoGap = 'NO_PAYEE' | 'NO_BANK' | 'NO_ACCOUNT' | 'NO_ADDRESS' | 'NO_CONTACT'

export interface PaymentInfoFacts {
  /** The chosen method kind (`ACH`, `CHECK`, …), or null when the bill has no payee. */
  method?: string | null
  /** True when the full routing + account numbers are on file (ACH only). */
  bankOnFile: boolean
  accountLast4?: string | null
  address?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
  /** The payee e-mail on the method: where a Zelle or Venmo payment goes. */
  contact?: string | null
}

export const PAYMENT_GAP_LABEL: Record<PaymentInfoGap, string> = {
  NO_PAYEE: 'No payee',
  NO_BANK: 'No bank info',
  NO_ACCOUNT: 'No account info',
  NO_ADDRESS: 'No remit address',
  NO_CONTACT: 'No contact',
}

const present = (value: string | null | undefined): boolean => (value ?? '').trim() !== ''

export function addressComplete(address: PaymentInfoFacts['address']): boolean {
  return !!address && present(address.street) && present(address.city) && present(address.state) && present(address.zip)
}

/** What is missing for this payee, or null when it can be paid. */
export function paymentInfoGap(facts: PaymentInfoFacts): PaymentInfoGap | null {
  const method = (facts.method ?? '').trim().toUpperCase()
  if (!method) return 'NO_PAYEE'
  switch (method) {
    case 'ACH':
      return facts.bankOnFile ? null : 'NO_BANK'
    case 'WIRE':
    case 'EFT':
      return present(facts.accountLast4) ? null : 'NO_ACCOUNT'
    case 'CHECK':
      return addressComplete(facts.address) ? null : 'NO_ADDRESS'
    case 'ZELLE':
    case 'VENMO':
      return present(facts.contact) ? null : 'NO_CONTACT'
    default:
      return null
  }
}

/** The sentence a screen or an error shows: who, and what to add. */
export function paymentGapMessage(gap: PaymentInfoGap, payeeName: string, method?: string | null): string {
  const who = payeeName.trim() || 'This payee'
  switch (gap) {
    case 'NO_PAYEE':
      return `${who} has no payment method on file. Add the pay-to on the carrier's Payment methods tab.`
    case 'NO_BANK':
      return `${who} has no bank details on file for ACH. Enter the routing and account numbers on the carrier's Payment methods tab.`
    case 'NO_ACCOUNT':
      return `${who} has no account on file for ${method === 'EFT' ? 'EFT' : 'the wire'}. Add the account on the carrier's Payment methods tab.`
    case 'NO_ADDRESS':
      return `${who} has no remit-to address on file for a check. Add the street, city, state and ZIP on the carrier's Payment methods tab.`
    case 'NO_CONTACT':
      return `${who} has no ${method === 'VENMO' ? 'Venmo' : 'Zelle'} contact on file. Add the payee e-mail on the carrier's Payment methods tab.`
  }
}
