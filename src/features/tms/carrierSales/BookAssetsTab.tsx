import { useCallback, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CapacityBoard } from '@/features/calendar/CapacityBoard'
import { TmsButton } from '@/features/tms/kit'
import { usePhoneWidth } from '@/features/tms/grid/denseCardLayout'
import { useDrivers } from '@/hooks/useDrivers'
import { useAuth } from '@/hooks/useAuth'
import { addDaysYmd, daysBetweenYmd, defaultCapacityRange, todayChicagoYmd } from '@/lib/capacityBoard'
import { formatDateShort } from '@/lib/date'

/**
 * The Book page's Assets tab: the same Capacity board as the Calendar's (one component, one stored board), with its own
 * range and the Previous / Today / Next steps the Calendar's toolbar gives it there.
 */
export function BookAssetsTab() {
  const { drivers } = useDrivers()
  const { user } = useAuth()
  const phone = usePhoneWidth()
  const [range, setRange] = useState(() => defaultCapacityRange(todayChicagoYmd()))
  const days = daysBetweenYmd(range.from, range.to) + 1

  const step = useCallback((dir: 1 | -1) => {
    setRange((r) => ({ from: addDaysYmd(r.from, dir * days), to: addDaysYmd(r.to, dir * days) }))
  }, [days])

  const label = useMemo(() => {
    const short = (day: string) => formatDateShort(new Date(`${day}T12:00:00Z`).toISOString())
    return range.from === range.to ? short(range.from) : `${short(range.from)} – ${short(range.to)}`
  }, [range])

  return (
    <div style={{ display: 'grid', gap: 8, padding: 'var(--tms-gap)' }} data-testid="book-assets-tab">
      <div className="tms-dense-bar">
        <span className="tms-dense-title">Book · Assets · Trucks to fill</span>
        <TmsButton size="sm" variant="secondary" aria-label="Previous days" onClick={() => step(-1)}><ChevronLeft size={14} aria-hidden="true" /></TmsButton>
        <TmsButton size="sm" variant="secondary" onClick={() => setRange(defaultCapacityRange(todayChicagoYmd()))}>Today</TmsButton>
        <TmsButton size="sm" variant="secondary" aria-label="Next days" onClick={() => step(1)}><ChevronRight size={14} aria-hidden="true" /></TmsButton>
        <span className="tms-muted" style={{ fontSize: 13 }}>{label}</span>
      </div>
      <div style={{ border: '1px solid var(--tms-border)', borderRadius: 12, background: 'var(--tms-card)', boxShadow: 'var(--tms-shadow)' }}>
        <CapacityBoard
          from={range.from}
          to={range.to}
          onRangeChange={(from, to) => setRange({ from, to })}
          drivers={drivers}
          phone={phone}
          userEmail={user?.email ?? 'dispatch'}
        />
      </div>
    </div>
  )
}
