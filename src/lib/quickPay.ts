/**
 * Quick pay — what it costs a carrier to be paid early.
 *
 * The carrier picks a rung off a ladder: get paid in a day and keep less of the
 * rate, wait three weeks and keep nearly all of it. The fee is an AP deduction we
 * cache on the LoadCarrier row at booking; it is never a CARRIER charge line, so it
 * cannot change the cost of the load. The rate confirmation prints it, and the net,
 * as information only.
 *
 * Days are matched exactly. A carrier asking for 10-day pay on a 7/15 ladder is not
 * quietly rounded onto a rung somebody else priced — the caller refuses instead.
 *
 * Imports are relative and type-only: the tmsCarrierActions and tmsShipmentActions
 * Lambdas bundle this file by path, so a `@/` alias would break the function build.
 */
import type { QuickPayTier, TmsSettings } from '../types/tms'

/** Ascending by days, as `normalizeQuickPayTiers` returns them: 1/3%, 7/2.5%, 15/2%, 21/1.5%. */
export const DEFAULT_QUICK_PAY_TIERS: readonly QuickPayTier[] = [
  { days: 1, feeBps: 300 },
  { days: 7, feeBps: 250 },
  { days: 15, feeBps: 200 },
  { days: 21, feeBps: 150 },
]

/** The rung priced for exactly this many days, or null when nobody priced it. */
export function tierFor(
  days: number,
  tiers?: readonly QuickPayTier[] | null,
): QuickPayTier | null {
  const ladder = tiers ?? DEFAULT_QUICK_PAY_TIERS
  return ladder.find((t) => t.days === days) ?? null
}

/** The deduction, rounded half up to the cent. Integer cents in, integer cents out. */
export function quickPayFee(rateCents: number, feeBps: number): number {
  if (!Number.isInteger(rateCents)) {
    throw new Error('Quick pay fee needs a whole number of cents.')
  }
  if (rateCents < 0) {
    throw new Error('Quick pay fee cannot be taken off a negative rate.')
  }
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error('Quick pay fee must be between 0 and 10000 basis points.')
  }
  return Math.round((rateCents * feeBps) / 10000)
}

export function netPayable(rateCents: number, feeCents: number): number {
  return rateCents - feeCents
}

/**
 * Validate a ladder somebody typed into settings. Returns it sorted ascending by
 * days so every reader sees one order. The last rule is the point of the whole
 * thing: waiting longer must never cost the carrier more, or the ladder is upside
 * down and nobody would ever pick the slow rung.
 */
export function normalizeQuickPayTiers(value: unknown): QuickPayTier[] {
  if (!Array.isArray(value)) {
    throw new Error('Quick pay tiers must be a list.')
  }
  if (value.length < 1 || value.length > 20) {
    throw new Error('Quick pay tiers must have between 1 and 20 entries.')
  }

  const tiers: QuickPayTier[] = value.map((raw) => {
    const tier = raw as Partial<QuickPayTier> | null
    const days = tier?.days
    const feeBps = tier?.feeBps
    if (!Number.isInteger(days) || (days as number) < 1) {
      throw new Error('Each quick pay tier needs a whole number of days, 1 or more.')
    }
    if (!Number.isInteger(feeBps) || (feeBps as number) < 0 || (feeBps as number) > 10000) {
      throw new Error('Each quick pay tier fee must be a whole number of basis points, 0 to 10000.')
    }
    return { days: days as number, feeBps: feeBps as number }
  })

  tiers.sort((a, b) => a.days - b.days)

  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].days === tiers[i - 1].days) {
      throw new Error(`Quick pay tiers repeat ${tiers[i].days} days.`)
    }
    if (tiers[i].feeBps > tiers[i - 1].feeBps) {
      throw new Error(
        `Quick pay at ${tiers[i].days} days costs more than at ${tiers[i - 1].days} days; a longer wait must never cost more.`,
      )
    }
  }

  return tiers
}

/** The org's ladder, falling back to the default one. Unreadable settings never throw here. */
export function quickPayTiersOf(
  settings: Pick<TmsSettings, 'quickPayTiers'> | null | undefined,
): QuickPayTier[] {
  const stored = settings?.quickPayTiers
  if (stored == null) return [...DEFAULT_QUICK_PAY_TIERS]
  try {
    return normalizeQuickPayTiers(stored)
  } catch {
    return [...DEFAULT_QUICK_PAY_TIERS]
  }
}
