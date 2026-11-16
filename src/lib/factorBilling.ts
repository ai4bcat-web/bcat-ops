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
import { isBrokerageRevDivision } from './reviewRequirements'

export type FactorBillingCustomer = Pick<CustomerRecord, 'factored' | 'billingMethod'>

/** Broker or shipper (Ryne 2026-11-14). Unset means nobody has said yet. */
export const CUSTOMER_TYPES = ['BROKER', 'SHIPPER'] as const
export type CustomerType = (typeof CUSTOMER_TYPES)[number]

/**
 * Only a broker we factor needs an MC: OTR looks a broker up by MC, while a shipper or beneficial cargo owner has
 * none. An unset type is not asked for an MC (it is flagged as needing a type instead).
 */
export function mcRequiredForFactoring(customer: (FactorBillingCustomer & { customerType?: CustomerType | null }) | null | undefined): boolean {
  return isFactorBilled(customer) && customer?.customerType === 'BROKER'
}

export function isFactorBilled(customer: FactorBillingCustomer | null | undefined): boolean {
  if (!customer) return false
  if (customer.billingMethod === 'MANUAL') return false
  return customer.billingMethod === 'FACTOR' || customer.factored === true
}

/**
 * Is this LOAD factored (Ryne 2026-11-16)? The customer is factor-billed AND the load is not in the BROKERAGE revenue
 * division: brokered loads are never factored. Same rule as reviewRequirements.customerFactorsForOtr(customer, division).
 */
export function isFactoredLoad(customer: FactorBillingCustomer | null | undefined, revDivision: string | null | undefined): boolean {
  return isFactorBilled(customer) && !isBrokerageRevDivision(revDivision)
}
