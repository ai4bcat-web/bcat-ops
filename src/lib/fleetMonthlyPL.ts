/**
 * LOCAL (Ivan) monthly P&L line math — shared by the Monthly P&L card and the
 * combined-profit card so they never disagree on the net figure.
 */

export interface FleetMonthlyRollup {
  revenue: number
  fuel: number
  driverCost: number
}
export interface FleetMonthlyCategories {
  financing: number
  maintenance: number
  lease: number
  other: number
  tolls: number
  insurance: number
  permits: number
}
export interface FleetFixedContribution {
  loanTrailers: number
  trailerLease: number
  yardRent: number
  tolls: number
}

export interface FleetMonthlyLines {
  loanTrucks: number
  loanTrailers: number
  trailerLease: number
  yardRent: number
  tolls: number
  eld: number
  maintenance: number
  other: number
  totalExpenses: number
  net: number
}

/**
 * Derive the monthly P&L lines. Loan-trailers / trailer-lease / yard-rent / tolls
 * are the editable fixed monthly contributions; loan-trucks is each truck's own loan
 * (financing minus the fixed loan-trailers); maintenance adds all-trailer invoices.
 */
export function computeFleetMonthlyLines(
  r: FleetMonthlyRollup,
  c: FleetMonthlyCategories,
  contrib: FleetFixedContribution,
  eld: number,
  trailerMaintenance: number,
): FleetMonthlyLines {
  const loanTrailers = contrib.loanTrailers
  const trailerLease = contrib.trailerLease
  const yardRent = contrib.yardRent
  const tolls = contrib.tolls
  const loanTrucks = Math.max(0, c.financing - loanTrailers)
  const maintenance = c.maintenance + trailerMaintenance
  const other = Math.max(0, c.lease - trailerLease) + Math.max(0, c.other - yardRent - eld) + Math.max(0, c.tolls - tolls)
  const totalExpenses = r.fuel + r.driverCost + loanTrucks + loanTrailers + trailerLease + yardRent + eld + maintenance + c.insurance + tolls + c.permits + other
  const net = r.revenue - totalExpenses
  return { loanTrucks, loanTrailers, trailerLease, yardRent, tolls, eld, maintenance, other, totalExpenses, net }
}
