/**
 * The ONE Miles value of the Route card (feedback 13). It follows the route (every stop, in order,
 * legs summed by GET_ROUTE_MILES: Distance Matrix per leg when the key answers, the straight-line
 * estimate per leg otherwise) until a person overrides it; the override sticks until cleared.
 * One number is written to BOTH underlying fields (customer miles and truck miles) so per-mile
 * rates, FSC/mile, margin, reports and the Load mapping keep reading what they read.
 *
 * Debounced 600 ms; any change of the route signature (a stop's address / zip, order, add, remove)
 * re-measures; a response for a route that is no longer current is dropped (stale-response guard).
 */
import { useEffect, useRef, useState } from 'react'
import type { ShipmentFormValues } from '../model'
import type { RoutePointInput } from '../sections/milesEstimate'
import { getRouteMiles } from '../sections/routeMilesApi'

type Ship = ShipmentFormValues['ship']

export type MilesSource = 'google' | 'estimate' | 'override' | null

export interface AutoMiles {
  /** Where the shown number came from. */
  source: MilesSource
  /** Set when the route could not be measured. */
  failed: boolean
}

/** Both miles fields get the same value. */
export const withMiles = (prev: Ship, miles: string): Ship => ({ ...prev, customerMiles: miles, truckMiles: miles })

export function useAutoMiles(
  routeKey: string,
  blocked: boolean,
  overridden: boolean,
  onChange: (patch: (prev: Ship) => Ship) => void,
  debounceMs = 600,
): AutoMiles {
  const [measured, setMeasured] = useState<{ source: 'google' | 'estimate' | null; failed: boolean }>({ source: null, failed: false })
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })
  useEffect(() => {
    if (!routeKey || blocked || overridden) return
    let current = true
    const timer = setTimeout(() => {
      getRouteMiles(JSON.parse(routeKey) as RoutePointInput[]).then(({ miles, source, error }) => {
        if (!current) return
        if (error || miles === null) { setMeasured((s) => ({ ...s, failed: true })); return }
        onChangeRef.current((prev) => withMiles(prev, String(miles)))
        setMeasured({ source, failed: false })
      })
    }, debounceMs)
    return () => { current = false; clearTimeout(timer) }
  }, [routeKey, blocked, overridden, debounceMs])
  return { source: overridden ? 'override' : measured.source, failed: measured.failed }
}

export const MILES_SOURCE_TEXT: Record<'google' | 'estimate' | 'override', string> = {
  google: 'Distance Matrix',
  estimate: 'Estimate',
  override: 'Override',
}
