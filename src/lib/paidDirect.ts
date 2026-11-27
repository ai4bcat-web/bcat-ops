/**
 * Money a driver was paid directly on a load, such as a lumper the broker handed them. The
 * settlement works the driver's share off the load's total less this amount (see
 * `paidDirectCents` in ownerOperatorTrips.ts); the customer invoice and the factored amount
 * stay at the full total.
 */

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/** The line printed under a trip's freight when part of it was paid direct. Empty when none. */
export function paidDirectNote(paidDirect: number): string {
  return paidDirect > 0 ? `less ${usd(paidDirect)} lumper paid direct to driver` : ''
}

interface ChargeLike {
  side?: string | null
  code?: string | null
  loadId?: string | null
  amountCents?: number | null
}

/**
 * What to pre-fill: the load's customer Lumper charge in dollars, or null when it has none. A
 * suggestion only, since a lumper is not always the driver's to keep and the office confirms the amount.
 */
export function lumperSuggestion(charges: readonly ChargeLike[], loadId: string): number | null {
  let cents = 0
  for (const c of charges) {
    if (c.side !== 'CUSTOMER' || (c.code ?? '').toUpperCase() !== 'LUMPER') continue
    if (c.loadId && c.loadId !== loadId) continue
    cents += Number(c.amountCents ?? 0)
  }
  return cents > 0 ? Math.round(cents) / 100 : null
}
