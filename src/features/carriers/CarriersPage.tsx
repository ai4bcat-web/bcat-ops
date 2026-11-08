/**
 * The carrier directory — MVMNT's carrier list (spec §3.3) on the shared dense grid.
 *
 * Three operational tabs with counts, a search box over name/DBA/MC/DOT, per-column header
 * filters and click-to-sort, the Columns dialog / density / summary controls, CSV of the
 * current view (admins), single click → profile sheet, double click → the carrier's own URL.
 * The deciding lives in `carrierViews.ts` and `carrierGridColumns.ts`; layout (columns,
 * widths, density, sort) is remembered per user under the board key `carriers`.
 *
 * `/tms/carriers/:id` renders the same board with that carrier's profile already open, so
 * a link to a carrier lands somewhere you can keep working from.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Download, RefreshCw, Search, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import {
  TmsBadge, TmsButton, TmsDialog, TmsField, TmsInput, TmsSegmentedTabs, TmsSelect, type TmsTone,
} from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import {
  ClearFiltersButton, ColumnsButton, DenseKpiStrip, DensityToggle, SummaryToggle,
} from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount, filterRows, nextSort, reorderKeys, sortDenseRows,
  type DenseColumnFilter, type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { useAuth } from '@/hooks/useAuth'
import { useCarriers } from '@/hooks/useCarriers'
import { getTmsSettings, graphqlErrorText, upsertCarrier } from '@/lib/apiClient'
import { effectiveCarrierStatus } from '@/lib/carrierStatus'
import { CarrierProfile } from './components/CarrierProfile'
import { CARRIER_TYPES } from './components/carrierFormModel'
import { CARRIER_DEFAULT_COLUMNS, carrierGridColumns, carriersToCsv } from './carrierGridColumns'
import {
  CARRIER_TABS, carrierTab, carrierTabCounts, matchesCarrierQuery,
  type CarrierRow, type CarrierTabKey,
} from './carrierViews'
import type { CarrierStatus, CarrierType, TmsSettings } from '@/types/tms'

const STATUS_TONE: Record<CarrierStatus, TmsTone> = {
  PENDING: 'orange', REVIEW: 'purple', ACTIVE: 'green', INACTIVE: 'gray', DO_NOT_USE: 'red',
}

export function CarriersPage() {
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const { isAdmin, user } = useAuth()
  const { carriers, loading, error, refresh, replace } = useCarriers()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [tab, setTab] = useState<CarrierTabKey>('active')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<DenseFilters>({})
  const [newCarrierOpen, setNewCarrierOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  // One clock for the whole board, so the effective status, the expiry filters and the
  // CSV all answer as of the same instant.
  const [now] = useState(() => new Date().toISOString())

  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])

  const catalog = useMemo(() => carrierGridColumns(now), [now])
  const prefs = useDenseGridPrefs({
    gridId: 'carriers',
    email: user?.email,
    defaultColumns: CARRIER_DEFAULT_COLUMNS,
    validKeys: catalog.map((c) => c.key),
    defaultSort: { key: 'name', dir: 'asc' },
  })
  const gridColumns = useMemo(
    () => prefs.columns.map((k) => catalog.find((c) => c.key === k)).filter((c) => c != null),
    [prefs.columns, catalog],
  )

  const counts = useMemo(() => carrierTabCounts(carriers, now), [carriers, now])
  const tabRows = useMemo(
    () => carriers.filter((row) => carrierTab(row, now) === tab && matchesCarrierQuery(row, query)),
    [carriers, tab, query, now],
  )
  const filteredRows = useMemo(() => filterRows(tabRows, catalog, filters), [tabRows, catalog, filters])
  const rows = useMemo(() => sortDenseRows(filteredRows, catalog, prefs.sort), [filteredRows, catalog, prefs.sort])

  const setColumnFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
  }, [])

  const kpis = useMemo(
    () => [
      { label: 'Carriers in view', value: rows.length },
      { label: 'Never hauled for us', value: rows.filter((r) => !r.loadCount).length },
      { label: 'Insurance lapsed', value: rows.filter((r) => effectiveCarrierStatus(r, now).derived).length, tone: 'warn' as const },
    ],
    [rows, now],
  )

  const renderCell = (row: CarrierRow, key: string) => {
    const col = catalog.find((c) => c.key === key)
    const text = col?.text(row) ?? ''
    if (key === 'status') return <TmsBadge tone={STATUS_TONE[effectiveCarrierStatus(row, now).status]}>{text}</TmsBadge>
    if (key === 'packet') return <TmsBadge tone="gray">{text}</TmsBadge>
    return text
  }

  const profileId = params.id ?? openId
  const closeProfile = () => {
    setOpenId(null)
    if (params.id) navigate('/tms/carriers')
  }

  const exportCsv = () => {
    const csv = carriersToCsv(rows, catalog)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `carriers-${now.slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const filterCount = activeFilterCount(filters)

  return (
    <>
      <div className="tms-dense-page">
        <div className="tms-dense-bar">
          <span className="tms-dense-title"><Truck size={18} aria-hidden="true" /> Carriers</span>
          <Search size={14} className="tms-muted" aria-hidden="true" />
          <TmsInput
            aria-label="Search"
            placeholder="Name, DBA, MC, DOT…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="tms-dense-search"
          />
          <TmsSegmentedTabs
            aria-label="Carrier status"
            size="sm"
            tabs={CARRIER_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }))}
            active={tab}
            onSelect={(key) => setTab(key as CarrierTabKey)}
          />
          <ClearFiltersButton count={filterCount} onClear={() => setFilters({})} />
          <span className="tms-dense-spacer" />
          <ColumnsButton
            catalog={catalog}
            columns={prefs.columns}
            widths={prefs.widths}
            pinned={prefs.pinned}
            onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
          />
          <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
          <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} />
          <TmsButton size="sm" aria-label="Refresh" onClick={() => { void refresh() }}><RefreshCw size={14} /></TmsButton>
          <Link className="tms-btn tms-btn-secondary tms-btn-sm" to="/tms/carriers/find" data-testid="launch-find-invite">Find &amp; invite</Link>
          {isAdmin ? <TmsButton size="sm" aria-label="CSV" onClick={exportCsv}><Download size={14} /> CSV</TmsButton> : null}
          {/* Step AM: a carrier enters the directory only through MyCarrierPackets (Find & invite / Cover). This hand entry
              is an admin-only data fix, audited server-side; nobody else sees it. */}
          {isAdmin ? <TmsButton size="sm" variant="primary" onClick={() => setNewCarrierOpen(true)}>Carrier (admin data fix)</TmsButton> : null}
        </div>
        {error && <p style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        <DenseKpiStrip open={prefs.kpiOpen} items={kpis} />
        <div className="tms-dense-body">
          <DenseGrid<CarrierRow>
            aria-label="Carriers"
            recentKey={`tms:carriers:recent:${user?.email ?? 'anon'}`}
            resetKey={`${tab}|${query}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
            columns={gridColumns}
            rows={rows}
            fitRows={tabRows}
            rowKey={(row) => row.id}
            renderCell={renderCell}
            density={prefs.density}
            userWidths={prefs.widths}
            stickyCount={Math.max(1, prefs.pinned.length)}
            sort={prefs.sort}
            onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
            filters={filters}
            onFilterChange={setColumnFilter}
            onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
            onResize={prefs.setWidth}
            onRowClick={(row) => setOpenId(row.id)}
            onRowDoubleClick={(row) => navigate(`/tms/carriers/${row.id}`)}
            empty={loading ? 'Reading the carrier directory…' : 'No carriers in this view.'}
          />
        </div>
      </div>

      {profileId && (
        <CarrierProfile
          key={profileId}
          carrierId={profileId}
          isAdmin={isAdmin}
          settings={settings}
          onClose={closeProfile}
          onChanged={replace}
        />
      )}

      {newCarrierOpen && (
        <NewCarrierDialog
          onClose={() => setNewCarrierOpen(false)}
          onCreated={(id) => {
            setNewCarrierOpen(false)
            refresh()
            setTab('pending')
            setOpenId(id)
          }}
        />
      )}
    </>
  )
}

/** Admin-only data fix: collects only what identifies them; everything else is the profile's job. */
function NewCarrierDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<CarrierType>('TL')
  const [mcNumber, setMcNumber] = useState('')
  const [dotNumber, setDotNumber] = useState('')
  const [owner, setOwner] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (!name.trim()) { setError('Name the carrier.'); return }
    if (!mcNumber.trim() && !dotNumber.trim()) { setError('An MC or DOT number is required.'); return }
    setBusy(true)
    setError(null)
    try {
      const carrier = await upsertCarrier({
        name: name.trim(),
        type,
        mcNumber: mcNumber.trim() || null,
        dotNumber: dotNumber.trim() || null,
        accountOwnerIds: owner.trim() ? [owner.trim()] : [],
      })
      toast.success('Carrier added — pending onboarding')
      onCreated(carrier.id)
    } catch (e) {
      setError(graphqlErrorText(e) || (e instanceof Error ? e.message : 'Create failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title="Add carrier (admin data fix)"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={create} disabled={busy}>{busy ? 'Adding…' : 'Add carrier'}</TmsButton>
        </>
      }
    >
      <TmsField label="Carrier name">
        <TmsInput aria-label="Carrier name" value={name} onChange={(e) => setName(e.target.value)} />
      </TmsField>
      <TmsField label="Type">
        <TmsSelect aria-label="Carrier type" value={type} onChange={(e) => setType(e.target.value as CarrierType)}>
          {CARRIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </TmsSelect>
      </TmsField>
      <div className="tms-grid tms-grid-2">
        <TmsField label="MC #">
          <TmsInput aria-label="MC number" value={mcNumber} onChange={(e) => setMcNumber(e.target.value)} />
        </TmsField>
        <TmsField label="DOT #">
          <TmsInput aria-label="DOT number" value={dotNumber} onChange={(e) => setDotNumber(e.target.value)} />
        </TmsField>
      </div>
      <TmsField label="Account owner">
        <RepPicker
          role="CARRIER_REP"
          allowUnknown
          value={owner}
          onChange={setOwner}
          placeholder="Pick an account owner…"
        />
      </TmsField>
      <p className="text-xs tms-muted" data-testid="admin-data-fix-note">
        Carriers normally arrive through MyCarrierPackets (Find &amp; invite, or Cover on a load). This is an audited data fix: the carrier lands in
        Pending and only becomes Active when MyCarrierPackets reports its setup complete.
      </p>
      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
