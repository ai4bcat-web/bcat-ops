import { ChevronLeft, ChevronRight, Plus, X, CheckCircle2, CircleDashed, HelpCircle, SplitSquareHorizontal, Search, AlertCircle } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/useAppStore'
import { DriverFilterMenu } from '@/components/DriverFilterMenu'
import type { FilterableDriver } from '@/lib/driverFilter'
import type { ViewMode } from '@/types'

interface CalendarToolbarProps {
  currentView: ViewMode
  dateLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  onViewChange: (view: ViewMode) => void
  /** Whose loads the board shows. Ivan's own drivers by default. */
  drivers: FilterableDriver[]
  visibleDriverIds: Set<string>
  onVisibleDriversChange: (ids: string[]) => void
}

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
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
  drivers, visibleDriverIds, onVisibleDriversChange,
}: CalendarToolbarProps) {
  const searchQuery      = useAppStore((s) => s.searchQuery)
  const filters          = useAppStore((s) => s.filters)
  const setSearchQuery   = useAppStore((s) => s.setSearchQuery)
  const toggleFilter     = useAppStore((s) => s.toggleFilter)
  const openNewShipment  = useAppStore((s) => s.openNewShipment)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      height: 56, padding: '0 20px',
      background: 'var(--tms-card)', borderBottom: '1px solid var(--tms-border)',
      flexShrink: 0, flexWrap: 'nowrap', overflowX: 'auto',
    }}>

      {/* ── Today ────────────────────────────────────────────────────────── */}
      <button onClick={onToday} style={{ ...navBtnStyle, padding: '4px 12px', fontSize: 12.5, fontWeight: 500, flexShrink: 0 }}>
        Today
      </button>

      {/* ── View tabs ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 2, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3, flexShrink: 0 }}>
        {VIEW_OPTIONS.map(({ value, label }) => {
          const active = currentView === value
          return (
            <button
              key={value}
              onClick={() => onViewChange(value)}
              style={{
                padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onPrev} aria-label="Previous" style={navBtnStyle}>
              <ChevronLeft size={15} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Previous</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onNext} aria-label="Next" style={navBtnStyle}>
              <ChevronRight size={15} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Next</TooltipContent>
        </Tooltip>
      </div>

      {/* ── Date label ───────────────────────────────────────────────────── */}
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tms-text)', whiteSpace: 'nowrap', minWidth: 160, flexShrink: 0 }} aria-live="polite">
        {dateLabel}
      </span>

      <div style={{ width: 1, height: 24, background: 'var(--tms-border)', flexShrink: 0 }} />

      {/* ── Filter chips ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden', minWidth: 0 }}>
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
                height: 30, padding: '0 10px', borderRadius: 20, border: '1px solid',
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
      <div style={{ position: 'relative', width: 240, flexShrink: 0 }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--tms-muted)', pointerEvents: 'none' }} />
        <input
          type="text"
          placeholder="Search loads — Pro#, TMS, PU#, driver, city, customer…"
          style={{
            width: '100%', height: 34, paddingLeft: 30, paddingRight: searchQuery ? 28 : 10,
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
        onClick={() => openNewShipment()}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8,
          background: 'var(--tms-primary)', color: 'var(--tms-on-primary)', border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0,
        }}
      >
        <Plus size={14} /> New Shipment
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
