/**
 * Driver fuel matching — single source of truth for "how much fuel did this card
 * burn this week". Used by the Driver Pay statement and the Amazon profitability
 * rollups so they always agree.
 *
 * Three guards keep the figure honest:
 *   1. Card match is numeric (leading zeros stripped) — "49" == "00049".
 *   2. Only genuine fuel counts. A transaction with an explicit itemCategory must be
 *      FUEL; one with NO category is classified by its fuelType (so scale fees,
 *      cash advances and cardlock/discount-diesel lines never sneak in via a missing
 *      category — which is what inflated some totals).
 *   3. De-duplicated by the EFS identity key, so a transaction that landed twice
 *      (overlapping report uploads) is only counted once.
 */
/**
 * The fields this module actually reads. Declared structurally rather than importing
 * `FuelTransaction` from the Amplify data client, so the same matching logic can run
 * in a Lambda (driver settlement) without dragging a browser-facing module in behind it.
 * `FuelTransaction` satisfies this shape, and the generics below hand callers their own
 * type straight back.
 */
export interface FuelTxLike {
  transactionDate: string
  cardNumber: string
  fuelType: string
  itemCategory?: string | null
  amount: number
  quantity: number
}

/** Card key for matching — digits only, leading zeros stripped ("00049" → "49"). */
export function normalizeCard(card: string | null | undefined): string {
  return (card ?? '').replace(/\D/g, '').replace(/^0+/, '')
}

// Item types EFS counts in "Total Fuel" (diesel + DEF + blends). Mirrors the importer.
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

/** Is this a fuel line? Trust an explicit category; otherwise fall back to fuelType. */
export function isFuelTx(tx: Pick<FuelTxLike, 'itemCategory' | 'fuelType'>): boolean {
  const cat = (tx.itemCategory ?? '').trim()
  if (cat) return cat === 'FUEL'
  return FUEL_ITEM_TYPES.has((tx.fuelType ?? '').toUpperCase().trim())
}

/**
 * Stable identity of an EFS fuel line — same key ⇒ same physical fill.
 *
 * Deliberately does NOT use the invoice number: the same fill re-imported from two
 * different reports can carry different invoice numbers, so keying on invoice lets
 * the duplicate through. Date + card + fuel type + amount + gallons fingerprints a
 * fill on its own; two genuinely separate fills (e.g. a second stop the same day)
 * differ in amount or gallons and are kept.
 *
 * Shared by the per-driver fuel match, the import-time skip, and the duplicate
 * cleanup so they all agree on what "the same transaction" means.
 */
export function fuelDedupKey(tx: Pick<FuelTxLike, 'transactionDate' | 'cardNumber' | 'fuelType' | 'amount' | 'quantity'>): string {
  return `${tx.transactionDate}|${normalizeCard(tx.cardNumber)}|${tx.fuelType}|${tx.amount}|${tx.quantity}`
}

/**
 * Fuel transactions for one card within [startIso, endIso] (inclusive), filtered to
 * real fuel and de-duplicated. Newest first.
 */
export function matchedFuelForCard<T extends FuelTxLike>(
  fuelTxs: T[],
  card: string | null | undefined,
  startIso: string,
  endIso: string,
): T[] {
  const want = normalizeCard(card)
  if (!want) return []
  const seen = new Set<string>()
  const out: T[] = []
  for (const tx of fuelTxs) {
    if (normalizeCard(tx.cardNumber) !== want) continue
    if (!isFuelTx(tx)) continue
    if (tx.transactionDate < startIso || tx.transactionDate > endIso) continue
    const key = fuelDedupKey(tx)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tx)
  }
  return out.sort((a, b) => (a.transactionDate < b.transactionDate ? 1 : -1))
}

export function sumFuel(txns: Pick<FuelTxLike, 'amount'>[]): number {
  return Math.round(txns.reduce((s, t) => s + (t.amount || 0), 0) * 100) / 100
}

/**
 * A fuel card pinned to a range of pay weeks.
 *
 * `from`/`until` are pay-week starts (YYYY-MM-DD), half-open like PayRateOverride: weeks
 * starting in [from, until) matched this card. Same convention as rateHistory and for the
 * same reason — a driver's fuel is derived live from the setting, so simply overwriting
 * fuelCardNumber when a card is swapped would re-match every past week against the new
 * card and silently zero the fuel on statements that were already paid.
 */
export interface FuelCardWindow {
  from: string
  until: string
  cardNumber: string
}

/**
 * Which card a pay week's fuel is matched against.
 *
 * The pinned window for that week wins; otherwise the current card. Chad on 2026-10-04:
 * weeks before it match 00056 from a window, weeks from it on match 00106 from the base
 * field — and last week's statement does not change.
 */
export function effectiveFuelCard(
  setting: { fuelCardNumber?: string | null; fuelCardHistory?: FuelCardWindow[] | null },
  periodStart: string,
): string | null {
  const hit = (setting.fuelCardHistory ?? []).find((w) => w.from <= periodStart && periodStart < w.until)
  return hit ? hit.cardNumber : (setting.fuelCardNumber ?? null)
}
