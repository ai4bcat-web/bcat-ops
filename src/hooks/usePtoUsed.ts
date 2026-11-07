import { useEffect, useState } from 'react'
import { listTimeClockEntries } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { ptoDaysUsed, yearOf } from '@/lib/timeOff'

/** PTO days one driver has used in the current calendar year; `days` is null while loading or if it failed. */
export function usePtoUsed(driverId: string | null | undefined): { year: string; days: number | null } {
  const year = yearOf(chicagoDateStr(new Date()))
  const [state, setState] = useState<{ driverId: string; days: number } | null>(null)

  useEffect(() => {
    if (!driverId) return
    let stale = false
    listTimeClockEntries({ from: `${year}-01-01`, to: `${year}-12-31`, driverId })
      .then((rows) => { if (!stale) setState({ driverId, days: ptoDaysUsed(rows, year) }) })
      .catch(() => { /* the figure just stays unknown */ })
    return () => { stale = true }
  }, [driverId, year])

  return { year, days: state && state.driverId === driverId ? state.days : null }
}
