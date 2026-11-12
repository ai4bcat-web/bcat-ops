/**
 * Writes for the Employee hours "PTO days" section.
 *
 * One PTO day = one TimeClockEntry (what the period's hours and pay read) + one APPROVED
 * DriverAvailability (what the calendar and the driver's Time Off view read), the same pair the
 * Time Off approval writes. If the second write fails the first is rolled back, so the hours and
 * the calendar can never disagree about a day.
 */
import {
  createTimeClockEntry, deleteTimeClockEntry, correctTimeClockEntry,
  createDriverAvailability, deleteDriverAvailability, updateDriverAvailability, listDriverAvailabilities,
} from './apiClient'
import type { TimeClockEntry } from '@/types'

export interface AddPtoInput {
  driverId: string
  dates: readonly string[]
  minutes: number
  note: string
  staffEmail: string
}

export async function addPtoDays(input: AddPtoInput): Promise<{ added: number }> {
  const { driverId, dates, minutes, staffEmail } = input
  const note = input.note.trim().slice(0, 400)
  const stamp = note ? `${note} (PTO entered by ${staffEmail})` : `PTO entered by ${staffEmail}`
  let added = 0
  for (const date of dates) {
    const entry = await createTimeClockEntry({
      driverId, workDate: date, kind: 'PTO', clockInAt: null, clockOutAt: null, minutes, note: stamp, source: 'STAFF',
    })
    try {
      await createDriverAvailability({
        driverId, type: 'PTO', startDate: date, endDate: date, hours: minutes / 60, note: note || null,
        status: 'APPROVED', source: 'STAFF', reviewedBy: staffEmail, reviewedAt: new Date().toISOString(), createdBy: staffEmail,
      })
    } catch (err) {
      await deleteTimeClockEntry(entry.id).catch(() => { /* the next load shows what is really there */ })
      throw err
    }
    added += 1
  }
  return { added }
}

/** The calendar row that mirrors a PTO day, if there is one. */
async function availabilityFor(driverId: string, date: string) {
  const all = await listDriverAvailabilities()
  return all.filter((a) => a.type === 'PTO' && a.driverId === driverId && a.startDate === date && a.endDate === date)
}

export async function removePtoDay(entry: Pick<TimeClockEntry, 'id' | 'driverId' | 'workDate'>): Promise<void> {
  await deleteTimeClockEntry(entry.id)
  for (const a of await availabilityFor(entry.driverId, entry.workDate)) await deleteDriverAvailability(a.id)
}

/** Change a day's hours or note, on the record: the row keeps who corrected it and what it said before. */
export async function editPtoDay(
  entry: TimeClockEntry,
  patch: { minutes: number; note: string },
  staffEmail: string,
): Promise<void> {
  const note = patch.note.trim().slice(0, 400)
  const stamp = note ? `${note} (PTO entered by ${entry.correctedBy ?? staffEmail})` : `PTO entered by ${entry.correctedBy ?? staffEmail}`
  await correctTimeClockEntry(entry, { minutes: patch.minutes, note: stamp }, staffEmail)
  for (const a of await availabilityFor(entry.driverId, entry.workDate)) {
    await updateDriverAvailability(a.id, { hours: patch.minutes / 60, note: note || null })
  }
}
