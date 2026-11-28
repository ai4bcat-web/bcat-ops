/**
 * "Is this fill already stored?" for the daily fuel ingest (scripts/ingestFuelReport.mjs).
 *
 * Mirrors src/lib/driverFuel.ts fuelDedupKey: date + card (digits only, leading zeros stripped) +
 * fuel type + amount + gallons, deliberately WITHOUT the invoice number. The same fill read from a
 * text report and from a PDF carries different invoice strings (the PDF appends the unit), so an
 * invoice-based key lets it in a second time. That is how the 2026-11-08 run stored four twins of
 * fills already in the table, and the 2026-10-11 run stored a PDF copy of a fill whose text copy
 * differed by 9 cents.
 *
 * Only rows stored BEFORE the run are compared. Several identical fills inside one report are real
 * (three $128.67 lines on invoices 127143-127145) and must all be kept.
 */
export const normalizeCard = (card) => String(card ?? '').replace(/\D/g, '').replace(/^0+/, '');

export const fuelIdentityKey = (t) => `${t.transactionDate}|${normalizeCard(t.cardNumber)}|${t.fuelType}|${t.amount}|${t.quantity}`;

/** Same date, card, fuel type and gallons, and an amount within this many dollars: a rounding difference between report formats. */
export const NEAR_AMOUNT_DOLLARS = 0.1;

const nearKey = (t) => `${t.transactionDate}|${normalizeCard(t.cardNumber)}|${t.fuelType}|${t.quantity}`;

/** Build the matcher from the rows already stored. */
export function storedFillMatcher(stored) {
  const exact = new Set();
  const near = new Map();
  for (const t of stored) {
    exact.add(fuelIdentityKey(t));
    const k = nearKey(t);
    near.set(k, [...(near.get(k) ?? []), Number(t.amount)]);
  }
  return (tx) => exact.has(fuelIdentityKey(tx))
    || (near.get(nearKey(tx)) ?? []).some((a) => Math.abs(a - tx.amount) <= NEAR_AMOUNT_DOLLARS + 1e-9);
}
