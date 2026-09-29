const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Money from dollars → "$1,234" (or "—" when null/0-and-dashable). */
export function fmtUSD(dollars: number | null | undefined, opts?: { cents?: boolean; dashZero?: boolean }): string {
  if (dollars == null) return '—'
  if (opts?.dashZero && dollars === 0) return '—'
  return usd0.format(dollars)
}

/** Money from integer cents → "$1,234.56" (or "—"). */
export function fmtCents(cents: number | null | undefined, dashZero = false): string {
  if (cents == null) return '—'
  if (dashZero && cents === 0) return '—'
  return usd2.format(cents / 100)
}
