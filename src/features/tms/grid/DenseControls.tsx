/**
 * The small controls that sit in a dense list's header bar: density toggle, summary toggle and
 * strip, Columns button, clear-filters. Each is stateless apart from its own popover or dialog.
 */
import { useState, type ReactNode } from 'react'
import { BarChart3, Columns3, FilterX } from 'lucide-react'
import { TmsButton } from '@/features/tms/kit'
import { ColumnsDialog, type ColumnsDialogResult } from './ColumnsDialog'
import type { DenseColumn, DenseDensity } from './denseGridModel'

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

/** The toolbar's Columns button and the shared dialog it opens (Load Tracking, Intake). */
export function ColumnsButton<T>({
  catalog,
  columns,
  widths,
  pinned,
  onApply,
}: {
  catalog: readonly DenseColumn<T>[]
  columns: string[]
  widths: Record<string, number>
  pinned: string[]
  /** The dialog's complete layout; its widths replace the saved ones. */
  onApply: (layout: ColumnsDialogResult) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TmsButton size="sm" variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Columns3 size={14} aria-hidden="true" /> Columns
      </TmsButton>
      <ColumnsDialog
        open={open}
        onOpenChange={setOpen}
        catalog={catalog}
        columns={columns}
        widths={widths}
        pinned={pinned}
        onApply={onApply}
      />
    </>
  )
}
