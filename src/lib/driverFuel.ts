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
import type { FuelTransaction } from '@/lib/apiClient'

/** Card key for matching — digits only, leading zeros stripped ("00049" → "49"). */
export function normalizeCard(card: string | null | undefined): string {
  return (card ?? '').replace(/\D/g, '').replace(/^0+/, '')
}

// Item types EFS counts in "Total Fuel" (diesel + DEF + blends). Mirrors the importer.
const FUEL_ITEM_TYPES = new Set(['ULSD', 'FUEL', 'DEFD', 'BIO', 'B5', 'B20', 'REG', 'PREM', 'DSL'])

/** Is this a fuel line? Trust an explicit category; otherwise fall back to fuelType. */
export function isFuelTx(tx: Pick<FuelTransaction, 'itemCategory' | 'fuelType'>): boolean {
  const cat = (tx.itemCategory ?? '').trim()
  if (cat) return cat === 'FUEL'
  return FUEL_ITEM_TYPES.has((tx.fuelType ?? '').toUpperCase().trim())
}

/** Stable identity of an EFS line — same key ⇒ same physical transaction. */
function fuelKey(tx: FuelTransaction): string {
  return `${tx.transactionDate}|${normalizeCard(tx.cardNumber)}|${tx.invoiceNumber ?? ''}|${tx.fuelType}|${tx.amount}`
}

/**
 * Fuel transactions for one card within [startIso, endIso] (inclusive), filtered to
 * real fuel and de-duplicated. Newest first.
 */
export function matchedFuelForCard(
  fuelTxs: FuelTransaction[],
  card: string | null | undefined,
  startIso: string,
  endIso: string,
): FuelTransaction[] {
  const want = normalizeCard(card)
  if (!want) return []
  const seen = new Set<string>()
  const out: FuelTransaction[] = []
  for (const tx of fuelTxs) {
    if (normalizeCard(tx.cardNumber) !== want) continue
    if (!isFuelTx(tx)) continue
    if (tx.transactionDate < startIso || tx.transactionDate > endIso) continue
    const key = fuelKey(tx)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tx)
  }
  return out.sort((a, b) => (a.transactionDate < b.transactionDate ? 1 : -1))
}

export function sumFuel(txns: Pick<FuelTransaction, 'amount'>[]): number {
  return Math.round(txns.reduce((s, t) => s + (t.amount || 0), 0) * 100) / 100
}
