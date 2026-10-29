/**
 * `/tms/dashboard` — the BCAT Logistics (Brokerage) dashboard.
 *
 * MVMNT's anatomy (`MVMNT_UI_REFERENCE.md` §3): title row with the Views selector and the
 * yellow chart picker, the filter row of italic chips, then a vertical stack of chart
 * cards — the 17 Classic cards followed by the brokerage cards Ryne asked for. The page
 * opens filtered to BROKERAGE and this month, grouped by division; the division chip can
 * widen to every business and every card can override the grouping.
 *
 * Everything on screen is read from the dev data. A card with nothing to show says so.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  ArrowLeftRight, ChevronDown, Download, Eye, Plus, RotateCw, Save, XCircle,
} from 'lucide-react'
import { TmsButton, TmsDialog, TmsFilterChip, TmsIconButton, TmsInput, TmsPage } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { indexOf } from '@/lib/dashboardCharts'
import { BROKERAGE_CHARTS } from './brokerageCards'
import { CLASSIC_CHARTS } from './classicCharts'
import { ChartCard } from './ChartCard'
import { useBrokerageDashboard } from './useBrokerageDashboard'
import {
  CLASSIC_VIEW, DATE_PRESETS, GROUP_BY_OPTIONS, chartsToCsv, dateChipLabel, defaultFilters,
  presetRange, readDashboardViews, writeDashboardViews,
  type DatePresetKey, type SavedDashboardView,
} from './dashboardViews'
import type { ChartDef, DashboardData, DashboardFilters, DashboardGroupBy } from './types'
import './dashboard.css'

const ALL_CHARTS: ChartDef[] = [...CLASSIC_CHARTS, ...BROKERAGE_CHARTS]

/** Which filter panel is open. `add` is the "+ Filter" chooser. */
type ChipKey = 'date' | 'division' | 'mode' | 'status' | 'customer' | 'carrier' | 'rep' | 'add'

/** The chips that are one value out of a list of what the window actually holds. */
type ListChipKey = Exclude<ChipKey, 'date' | 'division' | 'add'>

const LIST_CHIPS: { key: ListChipKey; label: string }[] = [
  { key: 'mode', label: 'Mode' },
  { key: 'status', label: 'Status' },
  { key: 'customer', label: 'Customer' },
  { key: 'carrier', label: 'Carrier' },
  { key: 'rep', label: 'Customer Rep' },
]

interface Option { value: string; label: string }

/** The values actually present in the window's data — never a hard-coded menu. */
function optionsFrom(data: DashboardData | null): Record<ListChipKey, Option[]> {
  if (!data) return { mode: [], status: [], customer: [], carrier: [], rep: [] }
  const index = indexOf(data)
  const modes = new Map<string, string>()
  const statuses = new Map<string, string>()
  const customers = new Map<string, string>()
  const carriers = new Map<string, string>()
  const reps = new Map<string, string>()
  for (const shipment of data.shipments) {
    if (shipment.voidedAt) continue
    modes.set(shipment.mode, shipment.mode.replace(/_/g, ' '))
    statuses.set(shipment.status, SHIPMENT_STATUS_LABELS[shipment.status] ?? shipment.status)
    if (shipment.customerId) customers.set(shipment.customerId, shipment.customerName ?? shipment.customerId)
    const rep = shipment.salesRepId ?? index.orderByShipmentId.get(shipment.id)?.customerRepId ?? null
    if (rep) reps.set(rep, index.repLabel(rep))
  }
  for (const leg of data.loadCarriers) {
    if (leg.carrierId) carriers.set(leg.carrierId, leg.carrierName ?? leg.carrierId)
  }
  for (const sample of data.samples) {
    if (sample.carrierId) carriers.set(sample.carrierId, sample.carrierName ?? sample.carrierId)
  }
  const sorted = (map: Map<string, string>): Option[] =>
    [...map].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  return {
    mode: sorted(modes),
    status: sorted(statuses),
    customer: sorted(customers),
    carrier: sorted(carriers),
    rep: sorted(reps),
  }
}

export function DashboardPage() {
  const { user } = useAuth()
  const email = user?.email ?? ''
  const [now] = useState(() => new Date().toISOString())

  const [filters, setFilters] = useState<DashboardFilters>(() => defaultFilters(now))
  const [groupBy, setGroupBy] = useState<DashboardGroupBy | null>('DIVISION')
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => ALL_CHARTS.map((chart) => chart.key))
  const [overrides, setOverrides] = useState<Record<string, DashboardGroupBy | null | undefined>>({})
  const [views, setViews] = useState<SavedDashboardView[]>(() => readDashboardViews(email))
  const [viewName, setViewName] = useState(CLASSIC_VIEW)
  const [openChip, setOpenChip] = useState<ChipKey | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  const { data, loading, error, failedMonths, refresh } = useBrokerageDashboard(filters)

  const options = useMemo(() => optionsFrom(data), [data])
  const divisionOptions = useMemo<Option[]>(
    () => (data?.divisions ?? [])
      .filter((division) => division.active !== false)
      .map((division) => ({ value: division.code, label: division.brand ? `${division.name} [${division.brand}]` : division.name })),
    [data],
  )

  const visible = useMemo(
    () => ALL_CHARTS.filter((chart) => visibleKeys.includes(chart.key)),
    [visibleKeys],
  )

  const cards = useMemo(() => {
    if (!data) return []
    return visible.map((def) => {
      const override = overrides[def.key]
      const effective = override === undefined ? groupBy : override
      return { def, series: def.compute(data, filters, effective) }
    })
  }, [data, visible, overrides, groupBy, filters])

  const setFilter = useCallback(<K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }, [])

  const applyPreset = useCallback((preset: DatePresetKey) => {
    if (preset === 'custom') return
    const range = presetRange(preset, now)
    setFilters((current) => ({ ...current, ...range }))
  }, [now])

  const clearAll = useCallback(() => {
    setFilters(defaultFilters(now))
    setGroupBy('DIVISION')
    setOverrides({})
    setVisibleKeys(ALL_CHARTS.map((chart) => chart.key))
    setViewName(CLASSIC_VIEW)
    setOpenChip(null)
  }, [now])

  const exportCsv = useCallback(() => {
    const csv = chartsToCsv(cards.map((card) => ({ title: card.def.title, series: card.series })))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `dashboard-${filters.from}-to-${filters.to}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }, [cards, filters.from, filters.to])

  const selectView = useCallback((name: string) => {
    setViewName(name)
    if (name === CLASSIC_VIEW) {
      setVisibleKeys(ALL_CHARTS.map((chart) => chart.key))
      return
    }
    const view = views.find((candidate) => candidate.name === name)
    if (!view) return
    setVisibleKeys(view.chartKeys)
    setFilters(view.filters)
    setGroupBy(view.groupBy)
  }, [views])

  const saveView = useCallback(() => {
    const name = saveName.trim()
    if (!name) return
    const next = [...views.filter((view) => view.name !== name), { name, chartKeys: visibleKeys, filters, groupBy }]
    setViews(next)
    writeDashboardViews(email, next)
    setViewName(name)
    setSaveOpen(false)
    setSaveName('')
  }, [saveName, views, visibleKeys, filters, groupBy, email])

  const divisionValue = filters.divisions.length === 0
    ? 'all'
    : filters.divisions.map((code) => divisionOptions.find((option) => option.value === code)?.label ?? code).join(', ')

  const labelFor = (list: Option[], value: string | null) =>
    (value ? list.find((option) => option.value === value)?.label ?? value : null)

  const title = (
    <span className="tms-dash-title">
      <ArrowLeftRight size={22} aria-hidden="true" />
      Dashboard
    </span>
  )

  const actions = (
    <>
      <label className="tms-dash-views">
        <Eye size={14} aria-hidden="true" />
        <select
          className="tms-select tms-dash-view-select"
          aria-label="Views"
          value={viewName}
          onChange={(event) => selectView(event.target.value)}
        >
          <option value={CLASSIC_VIEW}>{CLASSIC_VIEW}</option>
          {views.map((view) => <option key={view.name} value={view.name}>{view.name}</option>)}
        </select>
      </label>
      <TmsIconButton aria-label="Refresh" onClick={refresh}><RotateCw size={15} /></TmsIconButton>
      <TmsIconButton aria-label="Clear filters" onClick={clearAll}><XCircle size={15} /></TmsIconButton>
      <TmsIconButton aria-label="Save view" onClick={() => setSaveOpen(true)}><Save size={15} /></TmsIconButton>
      <TmsIconButton aria-label="Export CSV" onClick={exportCsv}><Download size={15} /></TmsIconButton>
      <button
        type="button"
        className="tms-dash-picker-btn"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((open) => !open)}
      >
        {`${visible.length} charts`}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </>
  )

  return (
    <TmsPage title={title} actions={actions} className="tms-dash">
      {pickerOpen ? (
        <div className="tms-dash-panel tms-dash-picker">
          {ALL_CHARTS.map((chart) => (
            <label key={chart.key} className="tms-dash-check">
              <input
                type="checkbox"
                checked={visibleKeys.includes(chart.key)}
                onChange={(event) => setVisibleKeys((current) => (event.target.checked
                  ? [...current, chart.key]
                  : current.filter((key) => key !== chart.key)))}
              />
              {chart.title}
            </label>
          ))}
        </div>
      ) : null}

      <div className="tms-dash-filters">
        <TmsIconButton aria-label="Reload data" onClick={refresh}><RotateCw size={14} /></TmsIconButton>
        <TmsFilterChip label="Pick Up" value={dateChipLabel(filters, now)} onClick={() => setOpenChip((open) => (open === 'date' ? null : 'date'))} />
        <TmsFilterChip label="Division is" value={divisionValue} onClick={() => setOpenChip((open) => (open === 'division' ? null : 'division'))} />
        <TmsFilterChip label="Mode is" value={labelFor(options.mode, filters.mode)} onClick={() => setOpenChip((open) => (open === 'mode' ? null : 'mode'))} />
        <TmsFilterChip label="Status is" value={labelFor(options.status, filters.status)} onClick={() => setOpenChip((open) => (open === 'status' ? null : 'status'))} />
        <TmsFilterChip label="Customer is" value={labelFor(options.customer, filters.customerId)} onClick={() => setOpenChip((open) => (open === 'customer' ? null : 'customer'))} />
        <TmsFilterChip label="Carrier is" value={labelFor(options.carrier, filters.carrierId)} onClick={() => setOpenChip((open) => (open === 'carrier' ? null : 'carrier'))} />
        <TmsFilterChip label="Customer Rep is" value={labelFor(options.rep, filters.repId)} onClick={() => setOpenChip((open) => (open === 'rep' ? null : 'rep'))} />
        <button type="button" className="tms-add-filter" onClick={() => setOpenChip((open) => (open === 'add' ? null : 'add'))}>
          <Plus size={13} aria-hidden="true" /> Filter
        </button>
        <label className="tms-dash-groupby">
          Group by
          <select
            className="tms-select"
            aria-label="Group by"
            value={groupBy ?? 'NONE'}
            onChange={(event) => setGroupBy(event.target.value === 'NONE' ? null : event.target.value as DashboardGroupBy)}
          >
            <option value="NONE">Nothing</option>
            {GROUP_BY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>

      {openChip === 'date' ? (
        <div className="tms-dash-panel">
          {DATE_PRESETS.filter((preset) => preset.key !== 'custom').map((preset) => (
            <TmsButton key={preset.key} size="sm" onClick={() => applyPreset(preset.key)}>{preset.label}</TmsButton>
          ))}
          <label className="tms-dash-date">
            From
            <TmsInput type="date" value={filters.from} onChange={(event) => setFilter('from', event.target.value)} />
          </label>
          <label className="tms-dash-date">
            To
            <TmsInput type="date" value={filters.to} onChange={(event) => setFilter('to', event.target.value)} />
          </label>
        </div>
      ) : null}

      {openChip === 'division' ? (
        <div className="tms-dash-panel tms-dash-divisions">
          <label className="tms-dash-check">
            <input
              type="checkbox"
              checked={filters.divisions.length === 0}
              onChange={() => setFilters((current) => ({ ...current, divisions: current.divisions.length === 0 ? ['BROKERAGE'] : [], subdivisions: [] }))}
            />
            Widen to all divisions
          </label>
          {divisionOptions.map((option) => (
            <label key={option.value} className="tms-dash-check">
              <input
                type="checkbox"
                checked={filters.divisions.includes(option.value)}
                onChange={(event) => setFilters((current) => ({
                  ...current,
                  divisions: event.target.checked
                    ? [...current.divisions, option.value]
                    : current.divisions.filter((code) => code !== option.value),
                }))}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}

      {openChip === 'add' ? (
        <div className="tms-dash-panel">
          <span className="tms-dash-date">Filter on</span>
          <TmsButton size="sm" onClick={() => setOpenChip('date')}>Pick up window</TmsButton>
          <TmsButton size="sm" onClick={() => setOpenChip('division')}>Division</TmsButton>
          {LIST_CHIPS.map((chip) => (
            <TmsButton key={chip.key} size="sm" onClick={() => setOpenChip(chip.key)}>{chip.label}</TmsButton>
          ))}
        </div>
      ) : null}

      {openChip && openChip !== 'date' && openChip !== 'division' && openChip !== 'add' ? (
        <div className="tms-dash-panel">
          <select
            className="tms-select"
            aria-label={`${openChip} filter`}
            value={(openChip === 'mode' ? filters.mode
              : openChip === 'status' ? filters.status
                : openChip === 'customer' ? filters.customerId
                  : openChip === 'carrier' ? filters.carrierId
                    : filters.repId) ?? ''}
            onChange={(event) => {
              const value = event.target.value || null
              if (openChip === 'mode') setFilter('mode', value)
              else if (openChip === 'status') setFilter('status', value)
              else if (openChip === 'customer') setFilter('customerId', value)
              else if (openChip === 'carrier') setFilter('carrierId', value)
              else setFilter('repId', value)
            }}
          >
            <option value="">Anything</option>
            {options[openChip].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      ) : null}

      {error ? <p className="tms-dash-error">{error}</p> : null}
      {failedMonths.length > 0 ? (
        <p className="tms-dash-error">
          {`These months could not be read, so they are missing from the numbers: ${failedMonths.map((month) => month.month).join(', ')}`}
        </p>
      ) : null}
      {loading && !data ? <p className="tms-dash-loading">Loading the window…</p> : null}

      <div className="tms-dash-cards">
        {cards.map((card) => (
          <ChartCard
            key={card.def.key}
            def={card.def}
            series={card.series}
            override={overrides[card.def.key]}
            onOverride={(next) => setOverrides((current) => ({ ...current, [card.def.key]: next }))}
          />
        ))}
      </div>

      <TmsDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save this dashboard view"
        description="The window, the filters, the grouping and the visible charts are saved for you on this browser."
        footer={<TmsButton variant="primary" onClick={saveView}>Save</TmsButton>}
      >
        <TmsInput
          aria-label="View name"
          placeholder="e.g. Brokerage month end"
          value={saveName}
          onChange={(event) => setSaveName(event.target.value)}
        />
      </TmsDialog>
    </TmsPage>
  )
}

export default DashboardPage
