/**
 * The small controls that sit in a dense list's header bar: density toggle, summary toggle and
 * strip, column chooser, clear-filters. Each is stateless apart from its own popover.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, BarChart3, Columns3, FilterX } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { reorderKeys, type DenseDensity } from './denseGridModel'

export function DensityToggle({ density, onChange }: { density: DenseDensity; onChange: (d: DenseDensity) => void }) {
  return (
    <div className="tms-dg-density" role="group" aria-label="Row density">
      {(['compact', 'comfortable'] as const).map((d) => (
        <button
          key={d}
          type="button"
          className={`tms-dg-density-btn${density === d ? ' tms-active' : ''}`}
          aria-pressed={density === d}
          onClick={() => onChange(d)}
        >
          {d === 'compact' ? 'Compact' : 'Comfortable'}
        </button>
      ))}
    </div>
  )
}

export function SummaryToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <TmsButton size="sm" variant={open ? 'primary' : 'secondary'} aria-expanded={open} aria-controls="tms-dg-kpi" onClick={onToggle}>
      <BarChart3 size={14} aria-hidden="true" /> Summary
    </TmsButton>
  )
}

export interface DenseKpi {
  label: string
  value: ReactNode
  tone?: 'warn' | 'bad' | 'good'
}

/** The KPI/summary strip above the table; renders nothing while collapsed. */
export function DenseKpiStrip({ open, items }: { open: boolean; items: DenseKpi[] }) {
  if (!open) return null
  return (
    <div id="tms-dg-kpi" className="tms-dg-kpis" role="region" aria-label="Summary">
      {items.map((k) => (
        <div key={k.label} className={`tms-dg-kpi${k.tone ? ` tms-dg-kpi-${k.tone}` : ''}`}>
          <span className="tms-dg-kpi-value">{k.value}</span>
          <span className="tms-dg-kpi-label">{k.label}</span>
        </div>
      ))}
    </div>
  )
}

export function ClearFiltersButton({ count, onClear }: { count: number; onClear: () => void }) {
  if (count === 0) return null
  return (
    <TmsButton size="sm" variant="secondary" onClick={onClear}>
      <FilterX size={14} aria-hidden="true" /> Clear {count} filter{count === 1 ? '' : 's'}
    </TmsButton>
  )
}

export interface ColumnChoice {
  key: string
  label: string
  fixed?: boolean
}

/** Show / hide and reorder columns from a short list (Load Tracking, Intake). */
export function ColumnChooser({
  all,
  visible,
  onChange,
  onReset,
}: {
  all: ColumnChoice[]
  visible: string[]
  onChange: (keys: string[]) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const byKey = new Map(all.map((c) => [c.key, c]))
  const shown = visible.map((k) => byKey.get(k)).filter((c): c is ColumnChoice => c != null)
  const hidden = all.filter((c) => !visible.includes(c.key))
  const move = (key: string, delta: -1 | 1) => {
    const movable = visible.filter((k) => !byKey.get(k)?.fixed)
    const i = movable.indexOf(key)
    const target = movable[i + delta]
    if (target) onChange(reorderKeys(visible, key, target))
  }

  return (
    <div ref={ref} className="tms-dg-chooser">
      <TmsButton size="sm" variant="secondary" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <Columns3 size={14} aria-hidden="true" /> Columns
      </TmsButton>
      {open && (
        <div className="tms-dg-chooser-pop" role="dialog" aria-label="Choose columns">
          <ul>
            {shown.map((c) => (
              <li key={c.key}>
                <label>
                  <input
                    type="checkbox"
                    checked
                    disabled={c.fixed}
                    aria-label={`Show ${c.label}`}
                    onChange={() => onChange(visible.filter((k) => k !== c.key))}
                  />
                  <span>{c.label || 'Actions'}</span>
                </label>
                {!c.fixed && (
                  <span className="tms-dg-chooser-move">
                    <button type="button" aria-label={`Move ${c.label} left`} onClick={() => move(c.key, -1)}>
                      <ArrowUp size={12} aria-hidden="true" />
                    </button>
                    <button type="button" aria-label={`Move ${c.label} right`} onClick={() => move(c.key, 1)}>
                      <ArrowDown size={12} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </li>
            ))}
            {hidden.map((c) => (
              <li key={c.key}>
                <label>
                  <input type="checkbox" checked={false} aria-label={`Show ${c.label}`} onChange={() => onChange([...visible, c.key])} />
                  <span>{c.label}</span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="tms-dg-filter-clear" onClick={onReset}>
            Reset columns
          </button>
        </div>
      )}
    </div>
  )
}
