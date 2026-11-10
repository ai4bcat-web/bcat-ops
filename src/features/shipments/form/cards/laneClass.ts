/** The side of the business a division belongs to: Brokerage, or Ivan Cartage (Assets and everything under it). Anything else is not compared by side. */
export function laneClassOfDivision(revDivision: string | null | undefined): 'BROKERAGE' | 'IVAN' | null {
  const code = (revDivision ?? '').trim().toUpperCase()
  if (code === 'BROKERAGE') return 'BROKERAGE'
  return ['ASSETS', 'OWNER_OPERATOR', 'BOX_TRUCK', 'LOCAL'].includes(code) ? 'IVAN' : null
}
