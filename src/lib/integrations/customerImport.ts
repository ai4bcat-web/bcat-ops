/**
 * Step J — the customer-import adapter contract.
 *
 * Best Care Auto Transport keeps its customer list in Square. A live Square
 * connection will pull customers through this shape; until credentials exist the
 * Square provider stub returns sample rows of the same shape so the Car Shipping
 * board has something real to consume.
 */

/** One customer as an external provider returns it, before BCAT normalization. */
export interface ImportedCustomerRow {
  /** The provider's own identifier for this customer. */
  externalId: string
  companyName: string
  contactName?: string | null
  email?: string | null
  phone?: string | null
  /** Free-form billing address; the importer normalizes it later. */
  billingAddress?: string | null
  /** ISO timestamp from the provider's record. */
  createdAt?: string | null
}

/** Signature a live customer-import adapter will implement. */
export type CustomerImportAdapter = (input: {
  credentials: Record<string, string>
  locationId: string
  since?: string | null
}) => Promise<{ rows: ImportedCustomerRow[] }>

/** Sample rows the Square stub returns until a live credential is stored. */
export function squareCustomerImportSample(): ImportedCustomerRow[] {
  return [
    {
      externalId: 'sq-customer-1',
      companyName: 'Best Care Auto Transport',
      contactName: 'Ryne Batory',
      email: 'ryne@bcatcorp.com',
      phone: '+1-555-0199',
      billingAddress: '1 Auto Plaza, Chicago, IL 60601',
      createdAt: '2026-10-29T12:00:00.000Z',
    },
    {
      externalId: 'sq-customer-2',
      companyName: 'Sample Dealer',
      contactName: null,
      email: null,
      phone: null,
      billingAddress: null,
      createdAt: '2026-10-28T12:00:00.000Z',
    },
  ]
}
