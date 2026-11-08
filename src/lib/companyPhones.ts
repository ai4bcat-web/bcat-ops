import type { CompanyPhone } from './apiClient'

/**
 * The writes that give `driverId` the phone `label` (or no phone, when `label` is null).
 *
 * A phone is in one driver's hands at a time and a driver carries one, so handing it
 * over takes it back from whoever had it — the select simply moves it — and whatever the
 * driver held before goes back to the office.
 */
export function phoneAssignmentWrites(
  phones: CompanyPhone[],
  driverId: string,
  label: string | null,
): Array<{ label: string; assignedDriverId: string | null }> {
  const writes: Array<{ label: string; assignedDriverId: string | null }> = []
  for (const p of phones) {
    if (p.assignedDriverId === driverId && p.label !== label) writes.push({ label: p.label, assignedDriverId: null })
  }
  if (label) {
    const target = phones.find((p) => p.label === label)
    if (target && target.assignedDriverId !== driverId) writes.push({ label, assignedDriverId: driverId })
  }
  return writes
}

/** The phone a driver carries, if any. */
export function phoneOf(phones: CompanyPhone[], driverId: string): CompanyPhone | null {
  return phones.find((p) => p.assignedDriverId === driverId) ?? null
}
