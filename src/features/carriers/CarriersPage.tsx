/**
 * The carrier directory — MVMNT's carrier list (spec §3.3).
 *
 * Three operational tabs with counts, a search box over name/DBA/MC/DOT, a filter rail,
 * CSV of the current view (admins), single click → profile sheet, double click → the
 * carrier's own URL. All of the deciding lives in `carrierViews.ts`; this file renders
 * what those functions return onto the MVMNT list page.
 *
 * `/tms/carriers/:id` renders the same board with that carrier's profile already open, so
 * a link to a carrier lands somewhere you can keep working from.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import {
  TmsBadge, TmsButton, TmsCard, TmsDialog, TmsField, TmsInput, TmsListPage, TmsSelect,
  type ColumnDef,
} from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { useCarriers } from '@/hooks/useCarriers'
import { getTmsSettings, graphqlErrorText, listCarrierDocuments, upsertCarrier } from '@/lib/apiClient'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { CarrierProfile } from './components/CarrierProfile'
import { CARRIER_TYPES } from './components/carrierFormModel'
import {
  CARRIER_COLUMNS, CARRIER_TABS, DEFAULT_INSURANCE_WARN_DAYS, DEFAULT_REQUIRED_CARRIER_DOCS,
  EMPTY_CARRIER_FILTERS, activeCarrierFilterCount, applyCarrierBoard, carrierEquipmentOptions,
  carrierOwnerOptions, carrierTabCounts, carriersToCsv,
  type CarrierBoardContext, type CarrierFilters, type CarrierRow, type CarrierSortDir, type CarrierSortKey,
  type CarrierTabKey, type InsuranceFilter,
} from './carrierViews'
import type { CarrierDocumentRecord, CarrierType, TmsSettings } from '@/types/tms'

/** The columns worth the width on screen; the CSV carries every column. */
const VISIBLE_COLUMN_KEYS = ['name', 'status', 'type', 'mcNumber', 'dotNumber', 'equipment', 'terms', 'loadCount', 'lastLoadAt']

const SORTABLE_KEYS: CarrierSortKey[] = ['name', 'status', 'type', 'loadCount', 'lastLoadAt']

export function CarriersPage() {
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const { isAdmin } = useAuth()
  const { carriers, loading, error, refresh, replace } = useCarriers()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [tab, setTab] = useState<CarrierTabKey>('active')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<CarrierFilters>(EMPTY_CARRIER_FILTERS)
  const [sortKey, setSortKey] = useState<CarrierSortKey>('name')
  const [sortDir, setSortDir] = useState<CarrierSortDir>('asc')
  const [showFilters, setShowFilters] = useState(false)
  const [newCarrierOpen, setNewCarrierOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<Record<string, CarrierDocumentRecord[]> | null>(null)

  // One clock for the whole board, so the effective status, the insurance filter and the
  // CSV all answer as of the same instant.
  const [now] = useState(() => new Date().toISOString())

  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])

  // Paperwork is a second whole-table read, so it waits until the filter asks for it.
  useEffect(() => {
    if (!filters.missingDocs || documents !== null) return
    listCarrierDocuments()
      .then((rows) => {
        const byCarrier: Record<string, CarrierDocumentRecord[]> = {}
        for (const row of rows) (byCarrier[row.carrierId] ??= []).push(row)
        setDocuments(byCarrier)
      })
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load carrier documents'))
  }, [filters.missingDocs, documents])

  const ctx = useMemo<CarrierBoardContext>(() => ({
    now,
    warnDays: settings?.insuranceWarnDays ?? DEFAULT_INSURANCE_WARN_DAYS,
    requiredDocs: settings?.requiredCarrierDocs ?? DEFAULT_REQUIRED_CARRIER_DOCS,
    documentsByCarrier: documents,
  }), [now, settings, documents])

  const counts = useMemo(() => carrierTabCounts(carriers, now), [carriers, now])
  const rows = useMemo(
    () => applyCarrierBoard(carriers, { tab, query, filters, sortKey, sortDir, ctx }),
    [carriers, tab, query, filters, sortKey, sortDir, ctx],
  )

  const columns = useMemo<ColumnDef<CarrierRow>[]>(
    () => CARRIER_COLUMNS.filter((c) => VISIBLE_COLUMN_KEYS.includes(c.key)).map((c) => ({
      key: c.key,
      header: c.label.toUpperCase(),
      sortable: SORTABLE_KEYS.includes(c.key as CarrierSortKey),
      render: (row: CarrierRow) => (
        c.key === 'status'
          ? <TmsBadge tone="gray">{CARRIER_STATUS_LABELS[effectiveCarrierStatus(row, now).status]}</TmsBadge>
          : c.value(row, ctx)
      ),
    })),
    [ctx, now],
  )

  const profileId = params.id ?? openId
  const closeProfile = () => {
    setOpenId(null)
    if (params.id) navigate('/tms/carriers')
  }

  const exportCsv = () => {
    const csv = carriersToCsv(rows, ctx)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `carriers-${now.slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const activeFilters = activeCarrierFilterCount(filters)

  return (
    <>
      <TmsListPage<CarrierRow>
        title="Carriers"
        primaryAction={{ label: 'Carrier', onClick: () => setNewCarrierOpen(true) }}
        actions={
          isAdmin
            ? <TmsButton aria-label="CSV" onClick={exportCsv}><Download size={14} /> CSV</TmsButton>
            : undefined
        }
        quickTabs={{
          tabs: CARRIER_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
          active: tab,
          onSelect: (key) => setTab(key as CarrierTabKey),
        }}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Name, DBA, MC, DOT…',
        }}
        onRefresh={() => { void refresh() }}
        filterChips={[
          { key: 'type', label: 'Type is', value: filters.type, onClick: () => setShowFilters((s) => !s) },
          { key: 'equipment', label: 'Equipment is', value: filters.equipment, onClick: () => setShowFilters((s) => !s) },
          { key: 'owner', label: 'Account owner is', value: filters.ownerId, onClick: () => setShowFilters((s) => !s) },
          {
            key: 'insurance',
            label: 'Insurance is',
            value: filters.insurance ? (filters.insurance === 'EXPIRING' ? 'Expiring soon' : 'Expired') : null,
            onClick: () => setShowFilters((s) => !s),
          },
          {
            key: 'docs',
            label: 'Paperwork is',
            value: filters.missingDocs ? 'Missing required docs' : null,
            onClick: () => setShowFilters((s) => !s),
          },
        ]}
        onAddFilter={() => setShowFilters((s) => !s)}
        fieldsLabel={activeFilters > 0 ? `${activeFilters} Filters` : undefined}
        onFields={() => setShowFilters((s) => !s)}
        banner={
          <>
            {error && <p style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
            {showFilters && (
              <FilterRail
                filters={filters}
                equipment={carrierEquipmentOptions(carriers)}
                owners={carrierOwnerOptions(carriers)}
                onChange={setFilters}
              />
            )}
          </>
        }
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={{ key: sortKey, dir: sortDir }}
        onSort={(key) => {
          const next = key as CarrierSortKey
          if (!SORTABLE_KEYS.includes(next)) return
          if (sortKey === next) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
          else { setSortKey(next); setSortDir('asc') }
        }}
        onRowClick={(row) => setOpenId(row.id)}
        onRowDoubleClick={(row) => navigate(`/tms/carriers/${row.id}`)}
        page={{ from: rows.length === 0 ? 0 : 1, to: rows.length, total: rows.length, pageSize: rows.length }}
        emptyText={loading ? 'Reading the carrier directory…' : 'No carriers in this view.'}
        onClearFilters={() => { setFilters(EMPTY_CARRIER_FILTERS); setQuery('') }}
      />

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

function FilterRail({ filters, equipment, owners, onChange }: {
  filters: CarrierFilters
  equipment: string[]
  owners: string[]
  onChange: (filters: CarrierFilters) => void
}) {
  const set = <K extends keyof CarrierFilters>(key: K, value: CarrierFilters[K]) => onChange({ ...filters, [key]: value })
  return (
    <TmsCard title="Filters">
      <div className="tms-grid tms-grid-4">
        <TmsField label="Type">
          <TmsSelect
            aria-label="Filter type"
            value={filters.type ?? ''}
            onChange={(e) => set('type', (e.target.value || null) as CarrierType | null)}
          >
            <option value="">All</option>
            {CARRIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Equipment">
          <TmsSelect
            aria-label="Filter equipment"
            value={filters.equipment ?? ''}
            onChange={(e) => set('equipment', e.target.value || null)}
          >
            <option value="">All</option>
            {equipment.map((code) => <option key={code} value={code}>{code.replace(/_/g, ' ').toLowerCase()}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Account owner">
          <TmsSelect
            aria-label="Filter account owner"
            value={filters.ownerId ?? ''}
            onChange={(e) => set('ownerId', e.target.value || null)}
          >
            <option value="">All</option>
            {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
          </TmsSelect>
        </TmsField>
        <TmsField label="Insurance">
          <TmsSelect
            aria-label="Filter insurance"
            value={filters.insurance ?? ''}
            onChange={(e) => set('insurance', (e.target.value || null) as InsuranceFilter | null)}
          >
            <option value="">All</option>
            <option value="EXPIRING">Expiring soon</option>
            <option value="EXPIRED">Expired</option>
          </TmsSelect>
        </TmsField>
      </div>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Filter missing documents"
          checked={filters.missingDocs}
          onChange={(e) => set('missingDocs', e.target.checked)}
        />
        Missing required docs
      </label>
    </TmsCard>
  )
}

/** "+ Carrier" collects only what identifies them; everything else is the profile's job. */
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
      title="Add carrier"
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
      <p className="text-xs tms-muted">
        New carriers land in Pending. They cannot be booked until compliance moves them to Active.
      </p>
      {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
    </TmsDialog>
  )
}
