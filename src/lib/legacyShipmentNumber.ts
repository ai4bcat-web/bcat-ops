/**
 * The number a legacy (Aljex-era) load carries on its Shipment.
 *
 * The 958 original BCAT loads were backfilled as `L<aljexId>` ('L14727', 'L14334  ' padded, two 'LPro# 14045').
 * The L was only ever a prefix that kept the backfilled number visibly apart from the counter's own; the PRO
 * itself is `normalizePro(Load.aljexId)`, and that is what every join already uses (ProClaim keys, the Aljex
 * importer's link key, the AR/AP ledgers). A Shipment number is therefore the bare, trimmed PRO whenever that is
 * safe, and `L<pro>` only as a fallback for a PRO that is not all digits or already belongs to another shipment.
 *
 * Nothing here is keyed on the old number: the backfill finds its rows by the load id (`stableId('shp', loadId)`)
 * and by `Load.aljexId`, so a shipment that still says 'L14727' and one that says '14727' are the same shipment to
 * every re-run, relink and import (`linkKeyForShipmentNumber` reads both spellings to the same key).
 */
import { normalizePro } from './proNumber'

export type LegacyNumberKind = 'L_DIGITS' | 'L_DIGITS_PADDED' | 'LPRO_LABEL'

export interface LegacyShipmentNumber {
  kind: LegacyNumberKind
  /** The PRO digits with the prefix, label and padding removed. */
  digits: string
}

/**
 * Recognise the three shapes the original backfill wrote; null for every other number (counter numbers, bare
 * digits, test prefixes such as 'LZZR1'). Exact shapes only: a number is never "close enough" to be rewritten.
 */
export function parseLegacyShipmentNumber(number: string | null | undefined): LegacyShipmentNumber | null {
  const raw = number ?? ''
  const plain = /^L(\d+)(\s*)$/.exec(raw)
  if (plain) return { kind: plain[2] ? 'L_DIGITS_PADDED' : 'L_DIGITS', digits: plain[1] }
  const labelled = /^LPro#\s*(\d+)\s*$/.exec(raw)
  if (labelled) return { kind: 'LPRO_LABEL', digits: labelled[1] }
  return null
}

/** The bare PRO a load's number should be: `normalizePro(aljexId)` when it is all digits, else null. */
export function digitsOnlyPro(aljexId: string | null | undefined): string | null {
  const pro = normalizePro(aljexId)
  return pro != null && /^\d+$/.test(pro) ? pro : null
}

/**
 * The number the backfill gives a new Shipment: the bare PRO, or `L<pro>` when the PRO is not all digits or
 * `collides` (another shipment already holds exactly that number). Never the raw padded string.
 */
export function backfillShipmentNumber(
  aljexId: string | null | undefined,
  loadId: string,
  collides: boolean,
): string {
  const pro = digitsOnlyPro(aljexId)
  if (pro != null && !collides) return pro
  return `L${normalizePro(aljexId) ?? ((aljexId ?? '').trim() || loadId)}`
}
