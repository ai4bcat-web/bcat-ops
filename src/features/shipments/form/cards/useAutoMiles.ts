/**
 * Customer Miles / Truck Miles follow the route until a person types over them (Ryne's feedback
 * #2, moved here from Shipping Requirements into the Route card's lane header). Behaviour is
 * unchanged: debounce 600 ms, GET_ROUTE_MILES through `getRouteMiles`, a field is overwritten
 * only while blank or still holding the last number we wrote.
 */
import { useEffect, useRef, useState } from 'react'
import type { ShipmentFormValues } from '../model'
import { mayAutoFill, type RoutePointInput } from '../sections/milesEstimate'
import { getRouteMiles } from '../sections/routeMilesApi'

type Ship = ShipmentFormValues['ship']

export interface AutoMiles {
  /** Where the number came from: the stop addresses, a straight-line estimate, or nothing yet. */
  source: 'google' | 'estimate' | null
  /** The last measured number; a miles field still holding it reads "est." rather than typed. */
  miles: string
  /** Set when the route could not be measured. */
  failed: boolean
}

export function useAutoMiles(
  routeKey: string,
  blocked: boolean,
  onChange: (patch: (prev: Ship) => Ship) => void,
): AutoMiles {
  const [state, setState] = useState<AutoMiles>({ source: null, miles: '', failed: false })
  const lastAuto = useRef({ customer: '', truck: '' })
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })
  useEffect(() => {
    if (!routeKey || blocked) return
    let alive = true
    const timer = setTimeout(() => {
      getRouteMiles(JSON.parse(routeKey) as RoutePointInput[]).then(({ miles, source, error }) => {
        if (!alive) return
        if (error || miles === null) { setState((s) => ({ ...s, failed: true })); return }
        const next = String(miles)
        onChangeRef.current((prev) => {
          const patch: Partial<Ship> = {}
          if (mayAutoFill(prev.customerMiles, lastAuto.current.customer)) patch.customerMiles = next
          if (mayAutoFill(prev.truckMiles, lastAuto.current.truck)) patch.truckMiles = next
          lastAuto.current = {
            customer: patch.customerMiles ?? lastAuto.current.customer,
            truck: patch.truckMiles ?? lastAuto.current.truck,
          }
          return { ...prev, ...patch }
        })
        setState({ source, miles: next, failed: false })
      })
    }, 600)
    return () => { alive = false; clearTimeout(timer) }
  }, [routeKey, blocked])
  return state
}
