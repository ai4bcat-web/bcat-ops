import { compareByOrder } from '@/lib/calendarOrder'
import { isLoadCanceled, isLoadVoided } from '@/lib/shipmentVoid'
import type { Load } from '@/types'

/** One row of the phone list: a load on the day it picks up, delivers, or both. Same rules as the Day board. */
export interface AgendaEntry { load: Load; role: 'pickup' | 'delivery' | 'same-day'; key: string }

/** 'YYYY-MM-DD' in Chicago, the timezone every calendar view buckets days in. */
export function chicagoDateStr(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2')
}

/**
 * The day's rows, in the order the Day board shows them (saved drag order, then appointment time). A load that picks up one day and
 * delivers another is on both days; an unscheduled load, or one with no usable pickup date, is on no day (see agendaUnscheduled).
 */
export function agendaForDay(loads: readonly Load[], dayStr: string): AgendaEntry[] {
  const out: AgendaEntry[] = []
  for (const l of loads) {
    if (isLoadVoided(l) || l.unscheduled) continue
    const puDay = chicagoDateStr(l.pickupAppt)
    if (!puDay) continue
    const deDay = chicagoDateStr(l.deliveryAppt) ?? puDay
    if (puDay !== deDay) {
      if (puDay === dayStr) out.push({ load: l, role: 'pickup', key: `${l.id}:pickup` })
      if (deDay === dayStr) out.push({ load: l, role: 'delivery', key: `${l.id}:delivery` })
    } else if (puDay === dayStr) {
      out.push({ load: l, role: 'same-day', key: `${l.id}:same-day` })
    }
  }
  const rowTime = (e: AgendaEntry) => (e.role === 'delivery' ? (e.load.deliveryAppt ?? e.load.pickupAppt) : e.load.pickupAppt) ?? ''
  return out.sort(compareByOrder<AgendaEntry>((e) => e.load.sortOrder, rowTime))
}

/** Loads parked as unscheduled or without a pickup date. Canceled and voided freight is not work, so it stays off. */
export function agendaUnscheduled(loads: readonly Load[]): AgendaEntry[] {
  return loads
    .filter((l) => !isLoadVoided(l) && !isLoadCanceled(l) && (l.unscheduled || !chicagoDateStr(l.pickupAppt)))
    .map((l) => ({ load: l, role: 'same-day' as const, key: `${l.id}:same-day` }))
}
