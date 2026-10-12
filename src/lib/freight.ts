/**
 * What is on the truck, as one line a driver or a dispatcher reads at a glance.
 *
 * The three facts live as separate Load fields (commodity, weight in pounds, piece count
 * with its unit) because the rate confirmation states them separately and the office
 * edits them separately. Everywhere they are DISPLAYED they read as one phrase, in the
 * order a shipper says them: "22 pallets · 41,000 lbs · Paper goods".
 */
export interface FreightLike {
  commodity?: string | null
  weight?: number | null
  pieces?: number | null
  piecesUnit?: string | null
}

export const PIECES_UNITS = ['pallets', 'cases', 'pieces', 'skids', 'rolls', 'bundles', 'drums', 'totes'] as const

export function formatWeight(lbs: number | null | undefined): string | null {
  if (typeof lbs !== 'number' || !Number.isFinite(lbs) || lbs <= 0) return null
  return `${Math.round(lbs).toLocaleString('en-US')} lbs`
}

export function formatPieces(pieces: number | null | undefined, unit?: string | null): string | null {
  if (typeof pieces !== 'number' || !Number.isFinite(pieces) || pieces <= 0) return null
  const n = Math.round(pieces)
  const u = (unit ?? '').trim().toLowerCase() || 'pieces'
  // "1 pallet", "22 pallets" — every unit we accept pluralises with a plain s.
  const word = n === 1 ? u.replace(/s$/, '') : u
  return `${n} ${word}`
}

/** One line, or null when the load carries no freight facts at all. */
export function freightSummary(f: FreightLike | null | undefined): string | null {
  if (!f) return null
  const parts = [formatPieces(f.pieces, f.piecesUnit), formatWeight(f.weight), (f.commodity ?? '').trim() || null]
    .filter((p): p is string => !!p)
  return parts.length ? parts.join(' · ') : null
}

export function hasFreight(f: FreightLike | null | undefined): boolean {
  return freightSummary(f) !== null
}
