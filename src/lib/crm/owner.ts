/** Step AB §5.1 — the sales rep of record for a customer. */
export interface OwnedCustomer {
  accountOwnerIds?: readonly string[] | null
  defaultSalesRepId?: string | null
}

/** `accountOwnerIds[0]` (the primary), else `defaultSalesRepId`, else null. */
export function ownerOf(customer: OwnedCustomer | null | undefined): string | null {
  if (!customer) return null
  const primary = (customer.accountOwnerIds ?? []).find((id) => typeof id === 'string' && id.trim() !== '')
  if (primary) return primary
  const fallback = customer.defaultSalesRepId
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback : null
}

/** Every id that owns the account: the owner list plus the default rep. */
export function ownerIdsOf(customer: OwnedCustomer | null | undefined): string[] {
  if (!customer) return []
  const ids = new Set<string>()
  for (const id of customer.accountOwnerIds ?? []) if (typeof id === 'string' && id.trim()) ids.add(id)
  if (typeof customer.defaultSalesRepId === 'string' && customer.defaultSalesRepId.trim()) {
    ids.add(customer.defaultSalesRepId)
  }
  return [...ids]
}
