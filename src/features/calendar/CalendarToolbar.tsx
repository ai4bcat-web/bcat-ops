import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, X, CheckCircle2, CircleDashed, HelpCircle, SplitSquareHorizontal, Search, AlertCircle, SlidersHorizontal } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/useAppStore'
import { DriverFilterMenu } from '@/components/DriverFilterMenu'
import type { FilterableDriver } from '@/lib/driverFilter'
import type { CalendarView } from './calendarView'

interface CalendarToolbarProps {
  currentView: CalendarView
  dateLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  onViewChange: (view: CalendarView) => void
  /** Whose loads the board shows. Ivan's own drivers by default. */
  drivers: FilterableDriver[]
  visibleDriverIds: Set<string>
  onVisibleDriversChange: (ids: string[]) => void
  /**
   * Phone width: the bar wraps onto rows (views and Today; date nav, Filters, New; search), the filter chips sit behind a Filters
   * button, and a List view is offered. Desktop is unchanged.
   */
  phone?: boolean
}

const VIEW_OPTIONS: { value: CalendarView; label: string }[] = [
  { value: 'day',   label: 'Day'   },
  { value: 'week',  label: 'Week'  },
  { value: 'month', label: 'Month' },
]


const FILTER_CHIPS = [
  { key: 'readyToInvoice'    as const, label: 'Ready to Invoice',     Icon: CheckCircle2,          activeColor: 'var(--tms-badge-green)', activeBg: 'var(--tms-badge-green-tint)'  },
  { key: 'notReadyToInvoice' as const, label: 'Not Ready to Invoice', Icon: CircleDashed,          activeColor: 'var(--tms-badge-turquoise)', activeBg: 'var(--tms-badge-turquoise-tint)'   },
  { key: 'split'          as const, label: 'Split Assignment',  Icon: SplitSquareHorizontal, activeColor: 'var(--tms-badge-purple)', activeBg: 'var(--tms-badge-purple-tint)' },
  { key: 'unassigned'     as const, label: 'Unassigned',        Icon: HelpCircle,            activeColor: 'var(--tms-badge-orange)', activeBg: 'var(--tms-badge-orange-tint)'  },
  { key: 'needsAppt'      as const, label: 'Needs Appt',        Icon: AlertCircle,           activeColor: 'var(--tms-badge-red)', activeBg: 'var(--tms-badge-red-tint)'    },
] as const

export function CalendarToolbar({
  currentView, dateLabel, onPrev, onNext, onToday, onViewChange,
  drivers, visibleDriverIds, onVisibleDriversChange, phone = false,
}: CalendarToolbarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const searchQuery      = useAppStore((s) => s.searchQuery)
  const filters          = useAppStore((s) => s.filters)
  const setSearchQuery   = useAppStore((s) => s.setSearchQuery)
  const toggleFilter     = useAppStore((s) => s.toggleFilter)
  const navigate         = useNavigate()
  const activeFilterCount = FILTER_CHIPS.filter(({ key }) => filters[key]).length
  // Phone sizes: 40px tap targets; each control's place in the wrapped rows.
  const tap = phone ? { width: 40, height: 40 } : null
  const at = (order: number): React.CSSProperties => (phone ? { order } : {})

  return (
    <div style={phone ? {
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      padding: '8px', background: 'var(--tms-card)', borderBottom: '1px solid var(--tms-border)', flexShrink: 0,
    } : {
      display: 'flex', alignItems: 'center', gap: 8,
      height: 56, padding: '0 20px',
      background: 'var(--tms-card)', borderBottom: '1px solid var(--tms-border)',
      flexShrink: 0, flexWrap: 'nowrap', overflowX: 'auto',
    }}>

      {/* ── Today ────────────────────────────────────────────────────────── */}
      <button onClick={onToday} style={{ ...navBtnStyle, padding: '4px 12px', fontSize: 12.5, fontWeight: 500, flexShrink: 0, ...(tap ? { width: 'auto', height: 40 } : {}), ...at(1) }}>
        Today
      </button>

      {/* ── View tabs ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 2, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3, flexShrink: 0, ...(phone ? { flex: '1 1 auto' } : {}), ...at(2) }}>
        {VIEW_OPTIONS.map(({ value, label }) => {
          const active = currentView === value
          return (
            <button
              key={value}
              aria-pressed={active}
              onClick={() => onViewChange(value)}
              style={{
                padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                ...(phone ? { flex: '1 1 0', minHeight: 34, padding: '4px 6px' } : {}),
                fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                background: active ? 'var(--tms-card)' : 'transparent',
                color: active ? 'var(--tms-text)' : 'var(--tms-muted)',
                boxShadow: active ? 'var(--tms-shadow)' : 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: phone ? 4 : 2, flexShrink: 0, ...at(4) }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onPrev} aria-label="Previous" style={{ ...navBtnStyle, ...tap }}>
              <ChevronLeft size={15} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Previous</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onNext} aria-label="Next" style={{ ...navBtnStyle, ...tap }}>
              <ChevronRight size={15} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Next</TooltipContent>
        </Tooltip>
      </div>

      {/* ── Date label ───────────────────────────────────────────────────── */}
      <span style={phone
        ? { fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', flex: '1 1 auto', minWidth: 0, ...at(5) }
        : { fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', whiteSpace: 'nowrap', minWidth: 160, flexShrink: 0 }} aria-live="polite">
        {dateLabel}
      </span>

      {!phone && <div style={{ width: 1, height: 24, background: 'var(--tms-border)', flexShrink: 0 }} />}

      {phone && (
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-controls="calendar-filters"
          style={{ ...navBtnStyle, width: 'auto', height: 40, padding: '0 12px', gap: 6, fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit', ...at(6) }}
        >
          <SlidersHorizontal size={14} aria-hidden="true" /> Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>
      )}

      {/* ── Filter chips ─────────────────────────────────────────────────── */}
      {/* On a phone they sit behind the Filters button and wrap instead of being cut off. */}
      <div
        id="calendar-filters"
        style={phone
          ? { display: filtersOpen ? 'flex' : 'none', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: '1 1 100%', minWidth: 0, ...at(9) }
          : { display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden', minWidth: 0 }}
      >
        {/* Whose loads, before which loads: this decides the board's population, and the
            chips below only narrow what it lets through. */}
        <DriverFilterMenu
          drivers={drivers}
          visibleDriverIds={visibleDriverIds}
          onChange={onVisibleDriversChange}
        />
        {FILTER_CHIPS.map(({ key, label, Icon, activeColor, activeBg }) => {
          const on = filters[key]
          return (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              aria-pressed={on}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                height: phone ? 40 : 30, padding: '0 10px', borderRadius: 20, border: '1px solid',
                fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap', flexShrink: 0,
                background: on ? activeBg : 'var(--tms-bg)',
                borderColor: on ? activeColor : 'var(--tms-border)',
                color: on ? activeColor : 'var(--tms-text-2)',
              }}
            >
              <Icon size={12} />
              {label}
              {on && (
                <span
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', background: 'color-mix(in srgb, var(--tms-text) 12%, transparent)', marginLeft: 2 }}
                  onClick={(e) => { e.stopPropagation(); toggleFilter(key) }}
                >
                  <X size={9} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Search ───────────────────────────────────────────────────────── */}
      <div style={{ position: 'relative', flexShrink: 0, ...(phone ? { flex: '1 1 100%', ...at(8) } : { width: 240 }) }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)', pointerEvents: 'none' }} />
        <input
          type="text"
          placeholder="Search loads — Pro#, TMS, PU#, driver, city, customer…"
          style={{
            width: '100%', height: phone ? 40 : 34, paddingLeft: 30, paddingRight: searchQuery ? 28 : 10,
            background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 7,
            fontSize: 12.5, color: 'var(--tms-text)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
          }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search loads"
        />
        {searchQuery && (
          <button
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tms-muted)', display: 'flex', alignItems: 'center' }}
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── New shipment ─────────────────────────────────────────────────── */}
      <button
        onClick={() => navigate('/tms/shipments/new')}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8,
          background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0,
          ...(phone ? { height: 40, padding: '0 12px' } : {}), ...at(7),
        }}
        aria-label="New Shipment"
      >
        <Plus size={14} /> {phone ? 'New' : 'New Shipment'}
      </button>
    </div>
  )
}

const navBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 7,
  background: 'var(--tms-bg)', border: '1px solid var(--tms-border)',
  color: 'var(--tms-text-2)', cursor: 'pointer',
}
