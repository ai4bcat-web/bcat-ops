/**
 * The Shipments board — MVMNT's shipment list (spec §6.4 "Board", §6.8 status tabs).
 *
 * Status tabs with counts, a search box over the server-built `searchKey`, a filter rail,
 * a column picker, this user's saved views, CSV of exactly what is on screen (admins),
 * single click → drawer, double click → full page. All of the deciding lives in
 * `shipmentViews.ts`; this file renders what those functions return.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Columns3, Download, Filter, Plus, RefreshCw, Save, Search, Star, Trash2, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipments } from '@/hooks/useShipments'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
import {
  createShipment, deleteShipment, duplicateShipment, getTmsSettings, graphqlErrorText,
  restoreShipment, setShipmentStatus, tenderRespond,
} from '@/lib/apiClient'
import { SHIPMENT_STATUS_LABELS } from '@/lib/shipmentStatus'
import { checkCallState } from '@/lib/checkCalls'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import { cn } from '@/lib/utils'
import { ShipmentDrawer } from './components/ShipmentDrawer'
import { ShipmentRowActions, type ShipmentActionHandlers } from './components/StatusActions'
import { MODE_OPTIONS } from './orderDraft'
import {
  BOARD_COLUMNS, BOARD_TABS, DEFAULT_COLUMN_KEYS, EMPTY_FILTERS, activeFilterCount, applyBoard,
  readSavedViews, removeView, tabCounts, toCsv, upsertView, visibleColumns, writeSavedViews,
  type BoardColumn, type BoardFilters, type BoardTabKey, type SavedView, type ShipmentRow, type SortDir,
  type SortKey,
} from './shipmentViews'
import type { ArStatus, AssignmentType, CustomerRecord, ShipmentMode, TmsSettings } from '@/types/tms'

const AR_STATUSES: ArStatus[] = ['DOCS_NEEDED', 'UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED']
const ASSIGNMENT_TYPES: AssignmentType[] = ['OWN_ASSET', 'CARRIER', 'NEED_TO_COVER']

export function ShipmentsBoard() {
  const navigate = useNavigate()
  const { isAdmin, user } = useAuth()
  const email = user?.email ?? ''
  const { shipments, loading, error, refresh } = useShipments()
  const { customers, locations } = useDirectory()
  const docReview = useDocumentReviewQueue()
  const [settings, setSettings] = useState<TmsSettings | null>(null)

  // Saved views are per user and per browser; the one marked default decides the landing
  // state, so re-opening the board returns to the list this person works from. Read once
  // at mount — a sign-in change remounts the board.
  const [boot] = useState(() => {
    const saved = readSavedViews(email)
    return { saved, landing: saved.find((v) => v.isDefault) ?? null }
  })
  const [tab, setTab] = useState<BoardTabKey>(boot.landing?.tab ?? 'all')
  const [query, setQuery] = useState(boot.landing?.query ?? '')
  const [filters, setFilters] = useState<BoardFilters>(boot.landing?.filters ?? EMPTY_FILTERS)
  const [columnKeys, setColumnKeys] = useState<string[]>(boot.landing?.columnKeys ?? [...DEFAULT_COLUMN_KEYS])
  const [sortKey, setSortKey] = useState<SortKey>(boot.landing?.sortKey ?? 'pickupAppt')
  const [sortDir, setSortDir] = useState<SortDir>(boot.landing?.sortDir ?? 'asc')
  const [views, setViews] = useState<SavedView[]>(boot.saved)
  const [showFilters, setShowFilters] = useState(false)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [newShipmentOpen, setNewShipmentOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // The check-call column is toned against a clock held in state rather than one read
  // during render: a DUE/OVERDUE tone only needs minute granularity, and a render-time
  // `Date.now()` is impure. The lazy initialiser runs outside the render-purity analysis.
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => { getTmsSettings().then(setSettings).catch(() => setSettings(null)) }, [])
  useEffect(() => {
    const t = setInterval(() => { setNowMs(Date.now()) }, 60_000)
    return () => clearInterval(t)
  }, [])

  // The review queue is the only place that knows a carrier upload is waiting, so the
  // board borrows its counts for the "Uploads to review" filter. Rows are rebuilt only
  // when something is actually pending — the common case copies nothing.
  const pendingByShipment = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const doc of docReview.documents) counts[doc.shipmentId] = (counts[doc.shipmentId] ?? 0) + 1
    return counts
  }, [docReview.documents])
  const boardRows = useMemo(
    () => (docReview.documents.length === 0
      ? shipments
      : shipments.map((s) => ({ ...s, pendingDocReviewCount: pendingByShipment[s.id] ?? null }))),
    [shipments, pendingByShipment, docReview.documents.length],
  )

  const counts = useMemo(() => tabCounts(boardRows), [boardRows])
  const rows = useMemo(
    () => applyBoard(boardRows, { tab, query, filters, sortKey, sortDir }),
    [boardRows, tab, query, filters, sortKey, sortDir],
  )
  const columns = visibleColumns(columnKeys)

  const applyView = (view: SavedView) => {
    setTab(view.tab); setQuery(view.query); setFilters(view.filters)
    setColumnKeys(view.columnKeys); setSortKey(view.sortKey); setSortDir(view.sortDir)
  }

  const persistViews = (next: SavedView[]) => { setViews(next); writeSavedViews(email, next) }

  const exportCsv = () => {
    const csv = toCsv(rows, columnKeys)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `shipments-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Truck size={18} />
        <h1 className="text-lg font-semibold">Shipments</h1>
        <Badge variant="outline">{rows.length}</Badge>
        <div className="relative ml-2 w-64">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search shipments"
            placeholder="Number, customer, city, reference…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 pl-7 text-sm"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowFilters((s) => !s)}>
          <Filter size={14} className="mr-1" /> Filters
          {activeFilterCount(filters) > 0 && <Badge className="ml-1">{activeFilterCount(filters)}</Badge>}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm"><Columns3 size={14} className="mr-1" /> Columns</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {BOARD_COLUMNS.map((c) => (
              <DropdownMenuItem
                key={c.key}
                onSelect={(e) => {
                  e.preventDefault()
                  setColumnKeys((prev) => prev.includes(c.key) ? prev.filter((k) => k !== c.key) : [...prev, c.key])
                }}
              >
                <input type="checkbox" readOnly checked={columnKeys.includes(c.key)} className="mr-2" />{c.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm"><Star size={14} className="mr-1" /> Views</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>Saved views</DropdownMenuLabel>
            {views.length === 0 && <DropdownMenuItem disabled>No saved views</DropdownMenuItem>}
            {views.map((v) => (
              <DropdownMenuItem key={v.id} onSelect={() => applyView(v)}>
                {v.isDefault && <Star size={12} className="mr-2 fill-current" />}
                <span className="flex-1 truncate">{v.name}</span>
                <Trash2
                  size={12}
                  className="ml-2 opacity-60"
                  onClick={(e) => { e.stopPropagation(); persistViews(removeView(views, v.id)) }}
                />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSaveViewOpen(true)}>
              <Save size={14} className="mr-2" />Save current view
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {isAdmin && (
          <Button variant="outline" size="sm" onClick={exportCsv}><Download size={14} className="mr-1" /> CSV</Button>
        )}
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Refresh" onClick={() => refresh()}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </Button>
        <Button size="sm" className="ml-auto" onClick={() => setNewShipmentOpen(true)}>
          <Plus size={14} className="mr-1" /> Shipment
        </Button>
      </header>

      <nav role="tablist" aria-label="Shipment status" className="flex gap-1 overflow-x-auto border-b border-border px-5">
        {BOARD_TABS.map((t) => (
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
          customers={customers.map((c) => ({ id: c.id, name: c.name }))}
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
                      const key = c.key as SortKey
                      if (!['pickupAppt', 'number', 'customerName', 'status'].includes(key)) return
                      if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
                      else { setSortKey(key); setSortDir('asc') }
                    }}
                  >
                    {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={columns.length + 1} className="py-8 text-center text-sm text-muted-foreground">No shipments in this view.</td></tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer border-b border-border/60 hover:bg-muted/40"
                onClick={() => setOpenId(row.id)}
                onDoubleClick={() => navigate(`/shipments/${row.id}`)}
              >
                {columns.map((c) => (
                  <td key={c.key} className="px-2 py-2">
                    <BoardCell column={c} row={row} nowMs={nowMs} />
                  </td>
                ))}
                <td className="px-1">
                  <ShipmentRowActions
                    shipment={row}
                    isAdmin={isAdmin}
                    cancelDeleteAdminOnly={settings?.cancelDeleteAdminOnly ?? false}
                    handlers={rowHandlers(row, refresh)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ShipmentDrawer
        shipmentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={refresh}
        customers={customers}
        locations={locations}
        settings={settings}
        isAdmin={isAdmin}
        currentUser={email}
      />

      {saveViewOpen && (
        <SaveViewDialog
          onClose={() => setSaveViewOpen(false)}
          onSave={(name, isDefault) => {
            persistViews(upsertView(views, {
              id: `view-${Date.now()}`, name, tab, query, filters, columnKeys, sortKey, sortDir, isDefault,
            }))
            setSaveViewOpen(false)
          }}
        />
      )}

      {newShipmentOpen && (
        <NewShipmentDialog
          customers={customers}
          defaultMode={(settings?.defaultMode as ShipmentMode | undefined) ?? 'FTL'}
          onClose={() => setNewShipmentOpen(false)}
          onCreated={(id) => { setNewShipmentOpen(false); refresh(); setOpenId(id) }}
        />
      )}
    </div>
  )
}

/**
 * One cell. Most columns are their own text, but status is a chip, the exception count is
 * a badge, and the check-call clock is coloured by `checkCallState` — the same function
 * the worklist and the notifier read, so one load is never amber here and red there.
 */
function BoardCell({ column, row, nowMs }: { column: BoardColumn; row: ShipmentRow; nowMs: number }) {
  if (column.key === 'status') {
    return <Badge variant="outline" className="text-[10px]">{SHIPMENT_STATUS_LABELS[row.status]}</Badge>
  }
  if (column.key === 'openIncidentCount') {
    const open = row.openIncidentCount ?? 0
    if (open === 0) return null
    return (
      <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive" data-testid="board-exceptions">
        {open}
      </Badge>
    )
  }
  if (column.key === 'docsMissing') {
    // Blank means the gate has never run for this shipment. Saying "complete" there
    // would be a claim nothing has checked.
    if (row.docsMissing == null) return null
    if (row.docsMissing.length === 0) {
      return <Check size={14} className="text-emerald-600" data-testid="board-docs" data-state="complete" />
    }
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 text-[10px] text-amber-700"
        data-testid="board-docs"
        data-state="missing"
        title={row.docsMissing.join(', ')}
      >
        {row.docsMissing.length} missing
      </Badge>
    )
  }
  if (column.key === 'nextCheckCallAt') {
    const state = checkCallState({ nextCheckCallAt: row.nextCheckCallAt }, nowMs)
    return (
      <span
        data-testid="board-next-check-call"
        data-state={state}
        className={cn(
          'tabular-nums',
          state === 'OVERDUE' && 'font-medium text-destructive',
          state === 'DUE' && 'font-medium text-amber-700',
        )}
      >
        {column.value(row)}
      </span>
    )
  }
  return <>{column.value(row)}</>
}

/**
 * The row menu acts on the row itself: every one of these needs only the shipment id and
 * the `updatedAt` the user is looking at, both of which the board already holds. Opening
 * the drawer first would be a round trip for nothing.
 */
function rowHandlers(row: ShipmentRow, refresh: () => void): ShipmentActionHandlers {
  const shipmentId = row.id
  const expectedUpdatedAt = row.updatedAt
  // The rethrow is for the menu's `run`, which keeps its dialog open on failure and
  // swallows the error there — the toast below is the only report the user gets.
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      toast.success(label)
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label} failed`)
      throw err
    }
  }
  return {
    onDuplicate: (copies, sameCarrier) =>
      run(`${copies.length} copy${copies.length === 1 ? '' : 'ies'} created`,
        () => duplicateShipment({ shipmentId, copies, sameCarrier })),
    onSetStatus: (status, reason) =>
      run('Status updated', () => setShipmentStatus({ shipmentId, expectedUpdatedAt, status, reason })),
    onDelete: () => run('Shipment deleted', () => deleteShipment({ shipmentId, expectedUpdatedAt })),
    onRestore: () => run('Shipment restored', () => restoreShipment({ shipmentId, expectedUpdatedAt })),
    onTenderRespond: (decision, reason) =>
      run('Tender updated', () => tenderRespond({ shipmentId, expectedUpdatedAt, decision, reason })),
  }
}

function FilterRail({ filters, customers, onChange }: {
  filters: BoardFilters
  customers: { id: string; name: string }[]
  onChange: (filters: BoardFilters) => void
}) {
  const set = <K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) => onChange({ ...filters, [key]: value })
  return (
    <div className="grid grid-cols-2 gap-3 border-b border-border bg-muted/20 px-5 py-3 sm:grid-cols-6">
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Customer</Label>
        <select
          aria-label="Filter customer"
          value={filters.customerId ?? ''}
          onChange={(e) => set('customerId', e.target.value || null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Pickup from</Label>
        <Input aria-label="Filter pickup from" type="date" value={filters.pickupFrom ?? ''} onChange={(e) => set('pickupFrom', e.target.value || null)} className="mt-1 h-8 text-sm" />
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Pickup to</Label>
        <Input aria-label="Filter pickup to" type="date" value={filters.pickupTo ?? ''} onChange={(e) => set('pickupTo', e.target.value || null)} className="mt-1 h-8 text-sm" />
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Mode</Label>
        <select
          aria-label="Filter mode"
          value={filters.mode ?? ''}
          onChange={(e) => set('mode', (e.target.value || null) as ShipmentMode | null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">AR</Label>
        <select
          aria-label="Filter AR status"
          value={filters.arStatus ?? ''}
          onChange={(e) => set('arStatus', (e.target.value || null) as ArStatus | null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {AR_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Assignment</Label>
        <select
          aria-label="Filter assignment"
          value={filters.assignmentType ?? ''}
          onChange={(e) => set('assignmentType', (e.target.value || null) as AssignmentType | null)}
          className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">All</option>
          {ASSIGNMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-4 sm:col-span-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Filter check call due"
            checked={filters.checkCallDue === true}
            onChange={(e) => set('checkCallDue', e.target.checked ? true : null)}
          />
          Check call due
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Filter check call overdue"
            checked={filters.checkCallOverdue === true}
            onChange={(e) => set('checkCallOverdue', e.target.checked ? true : null)}
          />
          Overdue
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Filter open exceptions"
            checked={filters.openExceptions === true}
            onChange={(e) => set('openExceptions', e.target.checked ? true : null)}
          />
          Open exceptions
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Filter docs missing"
            checked={filters.docsMissing === true}
            onChange={(e) => set('docsMissing', e.target.checked ? true : null)}
          />
          Docs missing
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Filter uploads to review"
            checked={filters.uploadsToReview === true}
            onChange={(e) => set('uploadsToReview', e.target.checked ? true : null)}
          />
          Uploads to review
        </label>
      </div>
    </div>
  )
}

function SaveViewDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, isDefault: boolean) => void }) {
  const [name, setName] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Save view</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
            <Input aria-label="View name" value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Make this my default view
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { if (!name.trim()) { setError('Name the view.'); return } onSave(name.trim(), isDefault) }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "+ Shipment" — active customers only, exactly as MVMNT gates it (spec §6.4). */
function NewShipmentDialog({ customers, defaultMode, onClose, onCreated }: {
  customers: CustomerRecord[]
  defaultMode: ShipmentMode
  onClose: () => void
  onCreated: (shipmentId: string) => void
}) {
  const [customerId, setCustomerId] = useState('')
  const [mode, setMode] = useState<ShipmentMode>(defaultMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Dormant is an automatic "no order in 90 days" label that a new order clears, so a
  // dormant customer is still shippable; only the lead stages, Pending and Blocked are
  // refused. The Lambda re-checks — this list exists so the user is not offered a name
  // the server will reject.
  const now = new Date().toISOString()
  const active = customers.filter((c) => {
    const status = effectiveCustomerStatus(c, null, now)
    return status === 'ACTIVE' || status === 'DORMANT'
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>New shipment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Customer</Label>
            <select
              aria-label="Customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">— select —</option>
              {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">Only active customers can be shipped.</p>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Mode</Label>
            <select
              aria-label="Mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as ShipmentMode)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {MODE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            disabled={busy}
            onClick={async () => {
              if (!customerId) { setError('Pick a customer.'); return }
              setBusy(true)
              try {
                const bundle = await createShipment({ customerId, mode })
                onCreated(bundle.shipment.id)
              } catch (err) {
                setError(graphqlErrorText(err) || (err instanceof Error ? err.message : 'Create failed'))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Creating…' : 'Create draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
