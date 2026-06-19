import { useState, useEffect, useMemo } from 'react'
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  getFilteredRowModel, flexRender,
  type ColumnDef, type SortingState, type VisibilityState,
  type RowSelectionState,
} from '@tanstack/react-table'
import {
  ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, Circle,
  Eye, Trash2, UserCheck, Plus, Download, Search, Filter, CalendarDays,
} from 'lucide-react'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { useIsMobile } from '@/hooks/useIsMobile'
import { MobileLoadAgenda } from '@/features/calendar/MobileLoadAgenda'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { useAppStore } from '@/store/useAppStore'
import { buildLoadHaystack, loadMatchesQuery } from '@/lib/loadSearch'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { formatDateTime } from '@/lib/date'
import { getStops } from '@/lib/stops'
import { cn } from '@/lib/utils'
import type { Load } from '@/types'
import { toast } from 'sonner'

// "Split" = handled by more than one driver. Legacy: pickup driver ≠ delivery driver.
// Multi-stop: more than one distinct driver across all the load's stops.
function isSplitLoad(l: Load, multiStop: boolean): boolean {
  if (multiStop) return new Set(getStops(l).map((s) => s.driverId)).size > 1
  return l.pickupDriverId !== l.deliveryDriverId && l.deliveryDriverId !== null
}

const COL_VIS_KEY = 'bcat-col-vis-v1'

function usePersistentColumnVisibility(): [VisibilityState, React.Dispatch<React.SetStateAction<VisibilityState>>] {
  const [vis, setVis] = useState<VisibilityState>(() => {
    try { return JSON.parse(localStorage.getItem(COL_VIS_KEY) || '{}') } catch { return {} }
  })
  useEffect(() => { localStorage.setItem(COL_VIS_KEY, JSON.stringify(vis)) }, [vis])
  return [vis, setVis]
}

function SortIcon({ col }: { col: { getIsSorted: () => false | 'asc' | 'desc' } }) {
  const s = col.getIsSorted()
  if (s === 'asc')  return <ArrowUp   className="size-3 ml-1" />
  if (s === 'desc') return <ArrowDown className="size-3 ml-1" />
  return <ArrowUpDown className="size-3 ml-1 opacity-30" />
}

type TabId = 'all' | 'ready' | 'notReady' | 'unassigned' | 'split'

const KPI_COLORS: Record<TabId, string> = {
  all:        '#1ea8f3',
  ready:      '#22c55e',
  notReady:   '#0891b2',
  unassigned: '#f59e0b',
  split:      '#a78bfa',
}

export function GridPage() {
  const { loads, updateLoad, deleteLoad } = useLoads()
  const { drivers } = useDrivers()
  const multiStopRender = useAppStore((s) => s.multiStopRender)
  const isMobile = useIsMobile()
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)

  const [tab, setTab] = useState<TabId>('all')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'pickupAppt', desc: false }])
  const [columnVisibility, setColumnVisibility] = usePersistentColumnVisibility()
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [groupByDay, setGroupByDay] = useState(false)
  const [showColMenu, setShowColMenu] = useState(false)

  const driverName = (id: string | null) => id ? (drivers.find((d) => d.id === id)?.name ?? '—') : 'Unassigned'

  // Tab-filtered data
  const tabFiltered = useMemo(() => {
    switch (tab) {
      case 'ready':      return loads.filter((l) => l.readyToInvoice)
      case 'notReady':   return loads.filter((l) => !l.readyToInvoice)
      case 'unassigned': return loads.filter((l) => !l.pickupDriverId)
      case 'split':      return loads.filter((l) => isSplitLoad(l, multiStopRender))
      default:           return loads
    }
  }, [loads, tab, multiStopRender])

  // Comprehensive search across ALL load fields (shared with calendar + top-bar search).
  const searched = useMemo(() => {
    if (!searchQuery.trim()) return tabFiltered
    return tabFiltered.filter((l) =>
      loadMatchesQuery(buildLoadHaystack(l, { driverName: (id) => drivers.find((d) => d.id === id)?.name }), searchQuery),
    )
  }, [tabFiltered, searchQuery, drivers])

  // Counts for tab badges
  const counts = useMemo(() => ({
    all:        loads.length,
    ready:      loads.filter((l) => l.readyToInvoice).length,
    notReady:   loads.filter((l) => !l.readyToInvoice).length,
    unassigned: loads.filter((l) => !l.pickupDriverId).length,
    split:      loads.filter((l) => isSplitLoad(l, multiStopRender)).length,
  }), [loads, multiStopRender])

  const columns = useMemo<ColumnDef<Load>[]>(() => [
    {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          onCheckedChange={table.getToggleAllPageRowsSelectedHandler() as (v: boolean | 'indeterminate') => void}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={row.getToggleSelectedHandler() as (v: boolean | 'indeterminate') => void}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      size: 40,
      enableSorting: false,
    },
    {
      accessorKey: 'aljexId',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          Pro # <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t1)', fontWeight: 500 }}>
          {getValue() as string}
        </span>
      ),
    },
    {
      accessorKey: 'tmsId',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          TMS ID / PO <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ds-t3)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
          {getValue() as string}
        </span>
      ),
    },
    {
      accessorKey: 'pickupNumber',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          PU# <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--ds-t3)' }}>
          {getValue() as string}
        </span>
      ),
    },
    {
      id: 'route',
      header: 'Origin → Destination',
      enableSorting: false,
      accessorFn: (row) => [row.originCity, row.destinationCity].filter(Boolean).join(' → '),
      cell: ({ row }) => {
        const l = row.original
        const origin = [l.originName, l.originCity].filter(Boolean).join(', ') || '—'
        const dest   = [l.destinationName, l.destinationCity].filter(Boolean).join(', ') || '—'
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--ds-t1)' }}>{origin}</span>
            <span style={{ color: 'var(--ds-t3)', fontSize: 11 }}>→</span>
            <span style={{ color: 'var(--ds-t1)' }}>{dest}</span>
          </div>
        )
      },
    },
    {
      accessorKey: 'pickupAppt',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          PU Appt <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t2)' }}>
          {formatDateTime(getValue() as string)}
        </span>
      ),
      sortingFn: 'datetime',
    },
    {
      accessorKey: 'deliveryAppt',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          DE Appt <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => {
        const v = getValue() as string
        const isTbd = !v || v.toLowerCase().includes('tbd')
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: isTbd ? 'var(--ds-amber)' : 'var(--ds-t2)' }}>
            {isTbd ? 'TBD' : formatDateTime(v)}
          </span>
        )
      },
      sortingFn: 'datetime',
    },
    {
      id: 'pickupDriver',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          PU Driver <SortIcon col={column} />
        </button>
      ),
      accessorFn: (row) => driverName(row.pickupDriverId),
      cell: ({ getValue }) => {
        const name = getValue() as string
        return (
          <span style={{ fontSize: 13, color: name === 'Unassigned' ? 'var(--ds-amber)' : 'var(--ds-t1)' }}>
            {name}
          </span>
        )
      },
    },
    {
      id: 'deliveryDriver',
      header: ({ column }) => (
        <button className="flex items-center" onClick={() => column.toggleSorting()}>
          DE Driver <SortIcon col={column} />
        </button>
      ),
      accessorFn: (row) => driverName(row.deliveryDriverId),
      cell: ({ getValue }) => {
        const name = getValue() as string
        return (
          <span style={{ fontSize: 13, color: name === 'Unassigned' ? 'var(--ds-amber)' : 'var(--ds-t2)' }}>
            {name}
          </span>
        )
      },
    },
    {
      accessorKey: 'readyToInvoice',
      header: 'RTI',
      cell: ({ row }) => {
        const load = row.original
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={load.readyToInvoice ? 'Mark not ready' : 'Mark ready to invoice'}
                onClick={(e) => {
                  e.stopPropagation()
                  updateLoad(load.id, { readyToInvoice: !load.readyToInvoice })
                  toast(load.readyToInvoice ? 'Marked not ready' : 'Marked ready to invoice')
                }}
                className="flex items-center gap-1"
              >
                {load.readyToInvoice
                  ? <CheckCircle2 className="size-4 text-emerald-600" />
                  : <Circle className="size-4" style={{ color: 'var(--ds-border-strong)' }} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{load.readyToInvoice ? 'Mark not ready' : 'Mark RTI'}</TooltipContent>
          </Tooltip>
        )
      },
      size: 60,
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [drivers])

  const table = useReactTable<Load>({
    data: searched,
    columns,
    state: { sorting, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
  })

  const selectedRows  = table.getSelectedRowModel().rows
  const selectedLoads = selectedRows.map((r) => r.original)
  const rows = table.getRowModel().rows

  const groupedRows = useMemo(() => {
    if (!groupByDay) return null
    const groups: Record<string, typeof rows> = {}
    for (const row of rows) {
      const day = formatDateTime(row.original.pickupAppt).split(',').slice(0, 2).join(',')
      if (!groups[day]) groups[day] = []
      groups[day].push(row)
    }
    return groups
  }, [rows, groupByDay])

  const bulkMarkRTI = () => {
    selectedLoads.forEach((l) => updateLoad(l.id, { readyToInvoice: true }))
    toast(`${selectedLoads.length} load(s) marked Ready to Invoice`)
    setRowSelection({})
  }

  const bulkDelete = () => {
    if (!confirm(`Delete ${selectedLoads.length} load(s)?`)) return
    selectedLoads.forEach((l) => deleteLoad(l.id))
    toast(`${selectedLoads.length} load(s) deleted`)
    setRowSelection({})
  }

  const allColNames: Record<string, string> = {
    aljexId: 'Pro #', tmsId: 'TMS ID / PO', pickupNumber: 'PU#', route: 'Origin → Dest',
    pickupAppt: 'PU Appt', deliveryAppt: 'DE Appt',
    pickupDriver: 'PU Driver', deliveryDriver: 'DE Driver', readyToInvoice: 'RTI',
  }

  const TABS: { id: TabId; label: string }[] = [
    { id: 'all',        label: 'All' },
    { id: 'ready',      label: 'Ready to Invoice' },
    { id: 'notReady',   label: 'Not Ready to Invoice' },
    { id: 'unassigned', label: 'Unassigned' },
    { id: 'split',      label: 'Split Loads' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Page header ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 24px', borderBottom: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)', flexShrink: 0, gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
            Loads
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
            All freight movements · live status
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Btn icon={<Download size={13} />} label="Export" />
          <button
            onClick={() => setSelectedLoad(null, 'create')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8,
              background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            <Plus size={14} /> Add Load
          </button>
        </div>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        gap: 12, padding: '14px 24px', background: 'var(--ds-bg)',
        borderBottom: '1px solid var(--ds-border)', flexShrink: 0,
      }}>
        {TABS.map(({ id, label }) => (
          <div
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'var(--ds-surface)', border: '1px solid var(--ds-border)',
              borderRadius: 10, padding: '12px 16px', cursor: 'pointer',
              position: 'relative', overflow: 'hidden',
              boxShadow: tab === id ? `0 0 0 2px ${KPI_COLORS[id]}33` : 'var(--sh-sm)',
              transition: 'box-shadow 0.15s',
            }}
          >
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
              background: KPI_COLORS[id], borderRadius: '3px 0 0 3px',
            }} />
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
              {label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, color: KPI_COLORS[id], letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
              {counts[id]}
            </div>
          </div>
        ))}
      </div>

      {/* ── Tab bar + toolbar ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 20px', borderBottom: '1px solid var(--ds-border)',
        background: 'var(--ds-surface)', flexShrink: 0, flexWrap: 'wrap', minHeight: 52,
      }}>
        {/* Tab buttons */}
        <div style={{ display: 'flex', gap: 2, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8, padding: 3 }}>
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 11px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: tab === id ? 600 : 500, fontFamily: 'inherit',
                background: tab === id ? '#fff' : 'transparent',
                color: tab === id ? 'var(--ds-t1)' : 'var(--ds-t3)',
                boxShadow: tab === id ? 'var(--sh-sm)' : 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
              <span style={{
                fontSize: 10, fontFamily: 'var(--font-mono)',
                color: tab === id ? KPI_COLORS[id] : 'var(--ds-t3)',
              }}>
                {counts[id]}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div style={{ position: 'relative', width: 240, flexShrink: 0 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
          <input
            style={{
              width: '100%', height: 34, paddingLeft: 30, paddingRight: 10,
              background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 7,
              fontSize: 12.5, color: 'var(--ds-t1)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
            }}
            placeholder="Search all fields…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Column visibility toggle */}
        <div style={{ position: 'relative' }}>
          <Btn icon={<Eye size={13} />} label="Columns" onClick={() => setShowColMenu((v) => !v)} />
          {showColMenu && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
              background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10,
              boxShadow: 'var(--sh-lg)', minWidth: 180, padding: '6px 0',
            }}>
              <div style={{ padding: '4px 14px 8px', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Show / hide
              </div>
              {table.getAllLeafColumns().filter((col) => col.id !== 'select').map((col) => (
                <label
                  key={col.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: 'var(--ds-t1)' }}
                >
                  <Checkbox
                    checked={col.getIsVisible()}
                    onCheckedChange={() => col.toggleVisibility()}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {allColNames[col.id] ?? col.id}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Group by day */}
        <Btn
          icon={<CalendarDays size={13} />}
          label="Group by day"
          active={groupByDay}
          onClick={() => setGroupByDay((v) => !v)}
        />

        {/* Load count */}
        <span style={{ fontSize: 12, color: 'var(--ds-t3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
          {table.getFilteredRowModel().rows.length} loads
        </span>

        {/* Bulk actions */}
        {selectedRows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8, paddingLeft: 12, borderLeft: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-blue)', background: 'var(--ds-blue-bg)', padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap' }}>
              {selectedRows.length} selected
            </span>
            <Btn icon={<UserCheck size={13} />} label="Mark RTI" onClick={bulkMarkRTI} />
            <Select onValueChange={(driverId) => {
              selectedLoads.forEach((l) => updateLoad(l.id, { pickupDriverId: driverId, deliveryDriverId: driverId }))
              toast(`${selectedLoads.length} load(s) reassigned`)
              setRowSelection({})
            }}>
              <SelectTrigger style={{ height: 32, fontSize: 12.5, width: 140 }}>
                <SelectValue placeholder="Reassign to…" />
              </SelectTrigger>
              <SelectContent>
                {drivers.filter((d) => d.active).map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              onClick={bulkDelete}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
                background: 'transparent', border: '1px solid var(--ds-red-bg)', color: 'var(--ds-red)',
                fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}

        <div style={{ flex: 1 }} />
        <Btn icon={<Filter size={13} />} label="Columns" onClick={() => {}} />
      </div>

      {/* ── Table (desktop) / card agenda (mobile) ──────────────────────────── */}
      {isMobile ? (
        <MobileLoadAgenda loads={searched} drivers={drivers} />
      ) : (
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--ds-bg)' }}>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} style={{ borderBottom: '1px solid var(--ds-border)' }}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    style={{
                      textAlign: 'left', padding: '9px 14px',
                      fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)',
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                      whiteSpace: 'nowrap', width: h.column.getSize() || undefined,
                      borderRight: '1px solid var(--ds-border)',
                    }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {groupedRows
              ? Object.entries(groupedRows).map(([day, dayRows]) => (
                  <GridDayGroup key={day} day={day} rows={dayRows} onRowClick={(id) => setSelectedLoad(id, 'view')} colCount={table.getAllLeafColumns().length} />
                ))
              : rows.map((row) => (
                  <GridRow key={row.id} row={row} onRowClick={() => setSelectedLoad(row.original.id, 'view')} />
                ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ padding: '48px 16px', textAlign: 'center', color: 'var(--ds-t3)', fontSize: 13 }}>
                  {loads.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                      <p>No loads yet.</p>
                      <button
                        onClick={() => setSelectedLoad(null, 'create')}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8,
                          background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
                          fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                        }}
                      >
                        <Plus size={14} /> Add your first load
                      </button>
                    </div>
                  ) : (
                    <p>No loads match your search.</p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      <LoadDrawer />
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Btn({ icon, label, active, onClick }: { icon?: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
        background: active ? 'var(--ds-blue-bg)' : 'var(--ds-bg)',
        border: `1px solid ${active ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
        color: active ? 'var(--ds-blue-dark)' : 'var(--ds-t2)',
        fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, whiteSpace: 'nowrap',
      }}
    >
      {icon} {label}
    </button>
  )
}

function GridDayGroup({
  day, rows, onRowClick, colCount,
}: {
  day: string
  rows: ReturnType<ReturnType<typeof useReactTable<Load>>['getRowModel']>['rows']
  onRowClick: (id: string) => void
  colCount: number
}) {
  return (
    <>
      <tr>
        <td
          colSpan={colCount}
          style={{
            padding: '6px 14px', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)',
            background: 'var(--ds-bg)', borderBottom: '1px solid var(--ds-border)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}
        >
          {day}
        </td>
      </tr>
      {rows.map((row) => (
        <GridRow key={row.id} row={row} onRowClick={() => onRowClick(row.original.id)} />
      ))}
    </>
  )
}

function GridRow({
  row,
  onRowClick,
}: {
  row: ReturnType<ReturnType<typeof useReactTable<Load>>['getRowModel']>['rows'][0]
  onRowClick: () => void
}) {
  const isRTI        = row.original.readyToInvoice
  const isUnassigned = row.original.pickupDriverId === null
  const isSelected   = row.getIsSelected()

  const bg = isSelected   ? 'rgba(30,168,243,0.07)'  :
             isRTI        ? 'rgba(34,197,94,0.06)'   :
             isUnassigned ? 'rgba(245,158,11,0.05)'  : 'transparent'

  const hoverBg = isSelected   ? 'rgba(30,168,243,0.11)'  :
                  isRTI        ? 'rgba(34,197,94,0.10)'   :
                  isUnassigned ? 'rgba(245,158,11,0.09)'  : 'var(--ds-bg-2)'

  return (
    <tr
      onClick={onRowClick}
      className={cn('group')}
      style={{ background: bg, borderBottom: '1px solid var(--ds-border)', cursor: 'pointer', transition: 'background 0.1s' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = hoverBg }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = bg }}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} style={{ padding: '9px 14px', borderRight: '1px solid rgba(226,232,240,0.5)', verticalAlign: 'middle' }}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  )
}
