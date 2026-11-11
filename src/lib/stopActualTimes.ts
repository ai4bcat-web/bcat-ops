/**
 * The actual times at each stop of a shipment's loads, with who recorded them. A time is an actual facility event only (never
 * inferred from the appointment); `source` says whether a person entered it (MANUAL, always wins), the Ivan driver app sent it
 * (DRIVER_APP) or the driver tapped it on a brokerage tracking link (TRACKING_LINK). An older time with no recorded source is
 * reported as `null`. Relative imports only.
 */
import type { Stop, StopTimeSource } from '../types'

export interface StopTimes {
  loadId: string
  stopId: string
  type: 'pickup' | 'delivery'
  sequence: number
  arrivedAt: string | null
  arrivedSource: StopTimeSource | null
  departedAt: string | null
  departedSource: StopTimeSource | null
  /** The last delivery of its load: its out time is "Delivered". */
  isFinalDelivery: boolean
}

export const STOP_TIME_SOURCE_LABEL: Record<StopTimeSource, string> = {
  MANUAL: 'manual',
  DRIVER_APP: 'driver app',
  TRACKING_LINK: 'tracking link',
}

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const source = (v: unknown): StopTimeSource | null => (v === 'MANUAL' || v === 'DRIVER_APP' || v === 'TRACKING_LINK' ? v : null)

/** Per stop, in route order, for every load of the bundle. */
export function stopTimesOf(bundle: { loads: ReadonlyArray<{ id: string; stops?: readonly Stop[] | null }> } | null): StopTimes[] {
  if (!bundle) return []
  const out: StopTimes[] = []
  for (const load of bundle.loads) {
    const stops = [...(load.stops ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    const lastDelivery = [...stops].reverse().find((s) => s.type === 'delivery')
    for (const s of stops) {
      if (s.type !== 'pickup' && s.type !== 'delivery') continue
      out.push({
        loadId: load.id, stopId: s.id, type: s.type, sequence: s.sequence ?? 0,
        arrivedAt: clean(s.arrivedAt), arrivedSource: clean(s.arrivedAt) ? source(s.arrivedSource) : null,
        departedAt: clean(s.departedAt), departedSource: clean(s.departedAt) ? source(s.departedSource) : null,
        isFinalDelivery: lastDelivery?.id === s.id,
      })
    }
  }
  return out
}

/** The label of a stop's out time: Delivered on the last delivery, Departed elsewhere. */
export function departedLabel(t: Pick<StopTimes, 'isFinalDelivery' | 'type'>): string {
  return t.isFinalDelivery && t.type === 'delivery' ? 'Delivered' : 'Departed'
}
