import { addDays } from './dates'

export interface TermsInput {
  /** Bill-to party's own terms (an existing record), if any. */
  billToTermsDays?: number | null
  /** Customer.paymentTermsDays of an existing customer. */
  customerTermsDays?: number | null
  /** TmsSettings.defaultPaymentTermsDays. */
  orgDefaultTermsDays?: number | null
}

const ok = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/**
 * Invoice terms: the export has no terms column, so the order is bill-to -> customer ->
 * org default (the app's own `invoiceTermsDays` order), and never an invented Net 0.
 * Returns `source` so the invoice note can say where the number came from; null days when
 * nothing is configured anywhere (the engine reports it rather than guessing).
 */
export function resolveTermsDays(input: TermsInput): { days: number | null; source: 'BILL_TO' | 'CUSTOMER' | 'ORG_DEFAULT' | 'NONE' } {
  if (ok(input.billToTermsDays)) return { days: input.billToTermsDays, source: 'BILL_TO' }
  if (ok(input.customerTermsDays)) return { days: input.customerTermsDays, source: 'CUSTOMER' }
  if (ok(input.orgDefaultTermsDays)) return { days: input.orgDefaultTermsDays, source: 'ORG_DEFAULT' }
  return { days: null, source: 'NONE' }
}

/** `invoiceDate + days` as YYYY-MM-DD (UTC calendar add, the app's `dueDateFor`). */
export function dueDate(invoiceDate: string, termsDays: number): string {
  return addDays(invoiceDate, termsDays)
}
