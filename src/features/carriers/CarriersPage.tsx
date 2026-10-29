/**
 * The carrier directory — MVMNT's carrier list (spec §3.3).
 *
 * Three operational tabs with counts, a search box over name/DBA/MC/DOT, a filter rail,
 * CSV of the current view (admins), single click → profile sheet, double click → the
 * carrier's own URL. All of the deciding lives in `carrierViews.ts`; this file renders
 * what those functions return.
 *
 * `/carriers/:id` renders the same board with that carrier's profile already open, so a
 * link to a carrier lands somewhere you can keep working from.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Download, Filter, Plus, RefreshCw, Search, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { useCarriers } from '@/hooks/useCarriers'
import { getTmsSettings, graphqlErrorText, listCarrierDocuments, upsertCarrier } from '@/lib/apiClient'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { cn } from '@/lib/utils'
import { CarrierProfile } from './components/CarrierProfile'
import { CARRIER_TYPES } from './components/carrierFormModel'
import {
  CARRIER_COLUMNS, CARRIER_TABS, DEFAULT_INSURANCE_WARN_DAYS, DEFAULT_REQUIRED_CARRIER_DOCS,
  EMPTY_CARRIER_FILTERS, activeCarrierFilterCount, applyCarrierBoard, carrierEquipmentOptions,
  carrierOwnerOptions, carrierTabCounts, carriersToCsv,
  type CarrierBoardContext, type CarrierFilters, type CarrierSortDir, type CarrierSortKey,
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
  const columns = CARRIER_COLUMNS.filter((c) => VISIBLE_COLUMN_KEYS.includes(c.key))

  const profileId = params.id ?? openId
  const closeProfile = () => {
    setOpenId(null)
    if (params.id) navigate('/carriers')
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Truck size={18} />
        <h1 className="text-lg font-semibold">Carriers</h1>
        <Badge variant="outline">{rows.length}</Badge>
        <div className="relative ml-2 w-64">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search carriers"
            placeholder="Name, DBA, MC, DOT…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 pl-7 text-sm"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowFilters((s) => !s)}>
          <Filter size={14} className="mr-1" /> Filters
          {activeCarrierFilterCount(filters) > 0 && <Badge className="ml-1">{activeCarrierFilterCount(filters)}</Badge>}
        </Button>
        {isAdmin && (
          <Button variant="outline" size="sm" onClick={exportCsv}><Download size={14} className="mr-1" /> CSV</Button>
        )}
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Refresh" onClick={() => refresh()}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </Button>
        <Button size="sm" className="ml-auto" onClick={() => setNewCarrierOpen(true)}>
          <Plus size={14} className="mr-1" /> Carrier
        </Button>
      </header>

      <nav role="tablist" aria-label="Carrier status" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {CARRIER_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
            <Badge variant="outline" className="text-[10px]">{counts[t.key]}</Badge>
          </button>
        ))}
      </nav>

      {showFilters && (
        <FilterRail
          filters={filters}
          equipment={carrierEquipmentOptions(carriers)}
          owners={carrierOwnerOptions(carriers)}
          onChange={setFilters}
        />
      )}

      {error && <p className="px-5 py-3 text-sm text-destructive">{error}</p>}

      <div className="flex-1 overflow-auto px-5 py-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              {columns.map((c) => (
                <th key={c.key} className="px-2 py-2">
                  <button
                    onClick={() => {
                      const key = c.key as CarrierSortKey
                      if (!SORTABLE_KEYS.includes(key)) return
                      if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                      else { setSortKey(key); setSortDir('asc') }
                    }}
                  >
                    {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={columns.length} className="py-8 text-center text-sm text-muted-foreground">
                  No carriers in this view.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer border-b border-border/60 hover:bg-muted/40"
                onClick={() => setOpenId(row.id)}
                onDoubleClick={() => navigate(`/carriers/${row.id}`)}
              >
                {columns.map((c) => (
                  <td key={c.key} className="px-2 py-2">
                    {c.key === 'status'
                      ? (
                        <Badge variant="outline" className="text-[10px]">
                          {CARRIER_STATUS_LABELS[effectiveCarrierStatus(row, now).status]}
                        </Badge>
                      )
                      : c.value(row, ctx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
    </div>
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
    <div className="grid grid-cols-2 gap-3 border-b border-border bg-muted/20 px-5 py-3 sm:grid-cols-5">
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Type</Label>
        <select
          aria-label="Filter type"
          value={filters.type ?? ''}
          onChange={(e) => set('type', (e.target.value || null) as CarrierType | null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {CARRIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Equipment</Label>
        <select
          aria-label="Filter equipment"
          value={filters.equipment ?? ''}
          onChange={(e) => set('equipment', e.target.value || null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {equipment.map((code) => <option key={code} value={code}>{code.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Account owner</Label>
        <select
          aria-label="Filter account owner"
          value={filters.ownerId ?? ''}
          onChange={(e) => set('ownerId', e.target.value || null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Insurance</Label>
        <select
          aria-label="Filter insurance"
          value={filters.insurance ?? ''}
          onChange={(e) => set('insurance', (e.target.value || null) as InsuranceFilter | null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          <option value="EXPIRING">Expiring soon</option>
          <option value="EXPIRED">Expired</option>
        </select>
      </div>
      <label className="flex items-end gap-2 pb-1 text-sm">
        <input
          type="checkbox"
          aria-label="Filter missing documents"
          checked={filters.missingDocs}
          onChange={(e) => set('missingDocs', e.target.checked)}
        />
        Missing required docs
      </label>
    </div>
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Add carrier</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Carrier name</Label>
            <Input aria-label="Carrier name" value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Type</Label>
            <select
              aria-label="Carrier type"
              value={type}
              onChange={(e) => setType(e.target.value as CarrierType)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {CARRIER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">MC #</Label>
              <Input aria-label="MC number" value={mcNumber} onChange={(e) => setMcNumber(e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">DOT #</Label>
              <Input aria-label="DOT number" value={dotNumber} onChange={(e) => setDotNumber(e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Account owner</Label>
            <RepPicker
              role="CARRIER_REP"
              allowUnknown
              value={owner}
              onChange={setOwner}
              placeholder="Pick an account owner…"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            New carriers land in Pending. They cannot be booked until compliance moves them to Active.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={create} disabled={busy}>{busy ? 'Adding…' : 'Add carrier'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
