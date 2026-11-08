/**
 * Why a typed invoice series start would be refused. The Lambda refuses with the same rule
 * (`saveArSettings`): the counter is "last issued", so the first new number is `start`, and it may
 * never reach back over a number already issued or imported. Null = acceptable (or nothing typed).
 */
export function invoiceSeriesStartProblem(
  raw: string,
  { counter, maxImported }: { counter: number | null; maxImported: number | null },
): string | null {
  const text = raw.trim()
  if (text === '') return null
  if (!/^\d+$/.test(text) || Number(text) < 1) return 'Enter a whole number of 1 or more.'
  const start = Number(text)
  if (counter != null && start - 1 < counter) {
    return `The counter is already at ${counter}; the new series must start above it (${counter + 1} or more).`
  }
  if (maxImported != null && start <= maxImported) {
    return `Imported Aljex invoices already use numbers up to ${maxImported}; start above that.`
  }
  return null
}
