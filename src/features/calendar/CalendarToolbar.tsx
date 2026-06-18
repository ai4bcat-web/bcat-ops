import { ChevronLeft, ChevronRight, Plus, X, CheckCircle2, CircleDashed, HelpCircle, SplitSquareHorizontal, Search, AlertCircle } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/useAppStore'
import type { ViewMode } from '@/types'

interface CalendarToolbarProps {
  currentView: ViewMode
  dateLabel: string
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  onViewChange: (view: ViewMode) => void
}

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'day',   label: 'Day'   },
  { value: 'week',  label: 'Week'  },
  { value: 'month', label: 'Month' },
]

const FILTER_CHIPS = [
  { key: 'readyToInvoice'    as const, label: 'Ready to Invoice',     Icon: CheckCircle2,          activeColor: '#16a34a', activeBg: 'var(--ds-green-bg)'  },
  { key: 'notReadyToInvoice' as const, label: 'Not Ready to Invoice', Icon: CircleDashed,          activeColor: '#0891b2', activeBg: 'var(--ds-cyan-bg)'   },
  { key: 'split'          as const, label: 'Split Assignment',  Icon: SplitSquareHorizontal, activeColor: '#7c3aed', activeBg: 'var(--ds-violet-bg)' },
  { key: 'unassigned'     as const, label: 'Unassigned',        Icon: HelpCircle,            activeColor: '#b45309', activeBg: 'var(--ds-amber-bg)'  },
  { key: 'needsAppt'      as const, label: 'Needs Appt',        Icon: AlertCircle,           activeColor: '#dc2626', activeBg: 'var(--ds-red-bg)'    },
] as const

export function CalendarToolbar({
  currentView, dateLabel, onPrev, onNext, onToday, onViewChange,
}: CalendarToolbarProps) {
  const searchQuery      = useAppStore((s) => s.searchQuery)
  const filters          = useAppStore((s) => s.filters)
  const setSearchQuery   = useAppStore((s) => s.setSearchQuery)
  const toggleFilter     = useAppStore((s) => s.toggleFilter)
  const setSelectedLoad  = useAppStore((s) => s.setSelectedLoad)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      height: 56, padding: '0 20px',
      background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)',
      flexShrink: 0, flexWrap: 'nowrap', overflowX: 'auto',
    }}>

      {/* ── View tabs ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 9, padding: 3, flexShrink: 0 }}>
        {VIEW_OPTIONS.map(({ value, label }) => {
          const active = currentView === value
          return (
            <button
              key={value}
              onClick={() => onViewChange(value)}
              style={{
                padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: 'inherit',
                background: active ? '#fff' : 'transparent',
                color: active ? 'var(--ds-t1)' : 'var(--ds-t3)',
                boxShadow: active ? 'var(--sh-sm)' : 'none',
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

        <button onClick={onToday} style={{ ...navBtnStyle, padding: '4px 10px', fontSize: 12.5, fontWeight: 500 }}>
          Today
        </button>

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
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', whiteSpace: 'nowrap', minWidth: 160, flexShrink: 0 }} aria-live="polite">
        {dateLabel}
      </span>

      <div style={{ width: 1, height: 24, background: 'var(--ds-border)', flexShrink: 0 }} />

      {/* ── Filter chips ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, overflow: 'hidden', minWidth: 0 }}>
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
                background: on ? activeBg : 'var(--ds-bg)',
                borderColor: on ? activeColor : 'var(--ds-border)',
                color: on ? activeColor : 'var(--ds-t2)',
              }}
            >
              <Icon size={12} />
              {label}
              {on && (
                <span
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', background: 'rgba(0,0,0,0.12)', marginLeft: 2 }}
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
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
        <input
          type="text"
          placeholder="Search loads — Pro#, TMS, PU#, driver, city, customer…"
          style={{
            width: '100%', height: 34, paddingLeft: 30, paddingRight: searchQuery ? 28 : 10,
            background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 7,
            fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
          }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search loads"
        />
        {searchQuery && (
          <button
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)', display: 'flex', alignItems: 'center' }}
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* ── New Load ─────────────────────────────────────────────────────── */}
      <button
        onClick={() => setSelectedLoad(null, 'create')}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8,
          background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0,
        }}
      >
        <Plus size={14} /> New Load
      </button>
    </div>
  )
}

const navBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 7,
  background: 'var(--ds-bg)', border: '1px solid var(--ds-border)',
  color: 'var(--ds-t2)', cursor: 'pointer',
}
