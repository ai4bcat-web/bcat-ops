/**
 * Whether a customer's loads are billed through the factor (OTR).
 *
 * Two columns say it, and they disagree on most customers: `billingMethod` is the
 * Step AW decision every customer was given (FACTOR or MANUAL), while `factored` is the
 * older flag that was left null on almost all of them. The billing method is the one a
 * person chose, so FACTOR counts on its own; `factored === true` still counts for the
 * few customers set up before billing methods existed. MANUAL never does.
 *
 * Relative imports only: the finance and shipment Lambdas bundle this file by path.
 */
import type { CustomerRecord } from '../types/tms'

export type FactorBillingCustomer = Pick<CustomerRecord, 'factored' | 'billingMethod'>

export function isFactorBilled(customer: FactorBillingCustomer | null | undefined): boolean {
  if (!customer) return false
  if (customer.billingMethod === 'MANUAL') return false
  return customer.billingMethod === 'FACTOR' || customer.factored === true
}
