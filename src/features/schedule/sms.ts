import { chicagoDateStr, formatApptTime } from '@/lib/date'
import { getStops } from '@/lib/stops'
import type { Load, Driver, Stop } from '@/types'

// ── Driver-schedule SMS builders ────────────────────────────────────────────────
//
// Legacy (whole-load) and multi-stop (per-stop) variants. The page picks one based on
// the multiStopRender flag. Pure functions — no React, no store — so they're unit-tested.

/** One stop assigned to a specific driver on a specific day (multi-stop SMS mode). */
export interface StopAssignment { load: Load; stop: Stop }

export function formatFullDate(dateStr: string): string {
  // dateStr = "YYYY-MM-DD"
  const d = new Date(`${dateStr}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
    year:    'numeric',
    timeZone: 'UTC',
  }).format(d)
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const ordinal = (i: number) => (i === 0 ? 'First' : (() => { const o = ORDINALS[i] ?? `#${i + 1}`; return o.charAt(0).toUpperCase() + o.slice(1) })())

// ── Legacy: one sentence per whole load ─────────────────────────────────────────

export function loadsForDriverOnDay(loads: Load[], driverId: string, dateStr: string): Load[] {
  return loads
    .filter((l) => l.pickupDriverId === driverId && chicagoDateStr(l.pickupAppt) === dateStr)
    .sort((a, b) => a.pickupAppt.localeCompare(b.pickupAppt))
}

export function buildSmsText(driver: Driver, loads: Load[], dateStr: string): string {
  const date = formatFullDate(dateStr)
  const first = driver.name.split(' ')[0]

  if (loads.length === 0) {
    return `Hi ${first}! No loads scheduled for ${date}.\n\n- BCAT Dispatch`
  }

  const loadSentences = loads.map((load, i) => {
    const puTime = formatApptTime(load.pickupAppt,   load.pickupApptType,   load.pickupApptEnd)
    const deTime = formatApptTime(load.deliveryAppt, load.deliveryApptType, load.deliveryApptEnd)
    const origin = [load.originName, load.originCity].filter(Boolean).join(' in ') || 'Origin TBD'
    const dest   = [load.destinationName, load.destinationCity].filter(Boolean).join(' in ') || 'Destination TBD'
    return `${ordinal(i)}, pick up at ${origin} at ${puTime} and deliver to ${dest} by ${deTime} (Load: ${load.aljexId}, PU#: ${load.pickupNumber}).`
  })

  const count = loads.length === 1 ? '1 load' : `${loads.length} loads`
  return `Hi ${first}! Here's your schedule for ${date}. You have ${count} today.\n\n${loadSentences.join(' ')}\n\n- BCAT Dispatch`
}

// ── Multi-stop: one sentence per stop ───────────────────────────────────────────
// A driver who only handles a middle delivery gets just that stop — not the whole load.

export function stopsForDriverOnDay(loads: Load[], driverId: string, dateStr: string): StopAssignment[] {
  const out: StopAssignment[] = []
  for (const load of loads) {
    for (const stop of getStops(load)) {
      if (stop.driverId === driverId && chicagoDateStr(stop.appt) === dateStr) {
        out.push({ load, stop })
      }
    }
  }
  return out.sort((a, b) => a.stop.appt.localeCompare(b.stop.appt))
}

export function buildStopSmsText(driver: Driver, items: StopAssignment[], dateStr: string): string {
  const date = formatFullDate(dateStr)
  const first = driver.name.split(' ')[0]

  if (items.length === 0) {
    return `Hi ${first}! No stops scheduled for ${date}.\n\n- BCAT Dispatch`
  }

  const sentences = items.map(({ load, stop }, i) => {
    const time = formatApptTime(stop.appt, stop.apptType, stop.apptEnd)
    if (stop.type === 'pickup') {
      const loc = [stop.name, stop.city].filter(Boolean).join(' in ') || 'pickup TBD'
      return `${ordinal(i)}, pick up at ${loc} at ${time} (Load: ${load.aljexId}, PU#: ${load.pickupNumber}).`
    }
    const loc = [stop.name, stop.city].filter(Boolean).join(' in ') || 'destination TBD'
    return `${ordinal(i)}, deliver to ${loc} by ${time} (Load: ${load.aljexId}).`
  })

  const count = items.length === 1 ? '1 stop' : `${items.length} stops`
  return `Hi ${first}! Here's your schedule for ${date}. You have ${count} today.\n\n${sentences.join(' ')}\n\n- BCAT Dispatch`
}
