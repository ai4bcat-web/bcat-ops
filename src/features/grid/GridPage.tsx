import { useState, useEffect, useMemo } from 'react'
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
  getFilteredRowModel, flexRender,
  type ColumnDef, type SortingState, type VisibilityState,
  type RowSelectionState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, Circle, Eye, Trash2, UserCheck, Plus } from 'lucide-react'
import { useLoads } from '@/hooks/useLoads'
import { useDrivers } from '@/hooks/useDrivers'
import { LoadDrawer } from '@/features/loads/LoadDrawer'
import { useAppStore } from '@/store/useAppStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { formatDateTime } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { Load } from '@/types'
import { toast } from 'sonner'

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
  if (s === 'asc') return <ArrowUp className="size-3 ml-1" />
  if (s === 'desc') return <ArrowDown className="size-3 ml-1" />
  return <ArrowUpDown className="size-3 ml-1 opacity-30" />
}

export function GridPage() {
  const { loads, updateLoad, deleteLoad } = useLoads()
  const { drivers } = useDrivers()
  const setSelectedLoad = useAppStore((s) => s.setSelectedLoad)

  const [sorting, setSorting] = useState<SortingState>([{ id: 'pickupAppt', desc: false }])
  const [globalFilter, setGlobalFilter] = useState('')
  const [columnVisibility, setColumnVisibility] = usePersistentColumnVisibility()
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [groupByDay, setGroupByDay] = useState(false)

  const driverName = (id: string | null) => id ? (drivers.find((d) => d.id === id)?.name ?? '—') : 'Unassigned'

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
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          ALJEX ID <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() as string}</span>,
    },
    {
      accessorKey: 'tmsId',
      header: ({ column }) => (
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          TMS ID / PO <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() as string}</span>,
    },
    {
      accessorKey: 'pickupNumber',
      header: ({ column }) => (
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          PU# <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() as string}</span>,
    },
    {
      accessorKey: 'pickupAppt',
      header: ({ column }) => (
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          PU Appt <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => <span className="text-xs">{formatDateTime(getValue() as string)}</span>,
      sortingFn: 'datetime',
    },
    {
      accessorKey: 'deliveryAppt',
      header: ({ column }) => (
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          DE Appt <SortIcon col={column} />
        </button>
      ),
      cell: ({ getValue }) => <span className="text-xs">{formatDateTime(getValue() as string)}</span>,
      sortingFn: 'datetime',
    },
    {
      id: 'pickupDriver',
      header: ({ column }) => (
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          Pickup Driver <SortIcon col={column} />
        </button>
      ),
      accessorFn: (row) => driverName(row.pickupDriverId),
      cell: ({ getValue }) => <span className="text-sm">{getValue() as string}</span>,
    },
    {
      id: 'deliveryDriver',
      header: ({ column }) => (
        <button className="flex items-center font-semibold" onClick={() => column.toggleSorting()}>
          Delivery Driver <SortIcon col={column} />
        </button>
      ),
      accessorFn: (row) => driverName(row.deliveryDriverId),
      cell: ({ getValue }) => {
        const name = getValue() as string
        return <span className={cn('text-sm', name === 'Unassigned' && 'text-amber-600')}>{name}</span>
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
                  : <Circle className="size-4 text-muted-foreground/40" />}
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
    data: loads,
    columns,
    state: { sorting, globalFilter, columnVisibility, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    globalFilterFn: 'includesString',
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
    aljexId: 'ALJEX ID', tmsId: 'TMS ID / PO', pickupNumber: 'PU#',
    pickupAppt: 'PU Appt', deliveryAppt: 'DE Appt',
    pickupDriver: 'Pickup Driver', deliveryDriver: 'Delivery Driver', readyToInvoice: 'RTI',
  }

  return (
    <div className="flex flex-col h-full">
      {/* KPI strip */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-white shrink-0 overflow-x-auto">
        <div className="ds-kpi">
          <div className="ds-kpi-label">Total Loads</div>
          <div className="ds-kpi-value blue">{loads.length}</div>
        </div>
        <div className="ds-kpi">
          <div className="ds-kpi-label">Ready to Invoice</div>
          <div className="ds-kpi-value green">{loads.filter((l) => l.readyToInvoice).length}</div>
        </div>
        <div className="ds-kpi">
          <div className="ds-kpi-label">Unassigned</div>
          <div className="ds-kpi-value amber">{loads.filter((l) => l.pickupDriverId === null).length}</div>
        </div>
        <div className="ds-kpi">
          <div className="ds-kpi-label">Split Loads</div>
          <div className="ds-kpi-value">{loads.filter((l) => l.pickupDriverId !== l.deliveryDriverId && l.deliveryDriverId !== null).length}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 min-h-[56px] py-2 border-b border-border bg-background shrink-0 flex-wrap">
        <Input
          placeholder="Search all fields…"
          className="h-9 w-52 text-xs bg-muted/40"
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
        />

        {/* Column visibility */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs">
              <Eye className="size-3.5" /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuLabel>Show / hide</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table.getAllLeafColumns()
              .filter((col) => col.id !== 'select')
              .map((col) => (
                <DropdownMenuItem key={col.id} onClick={() => col.toggleVisibility()} className="gap-2">
                  <Checkbox checked={col.getIsVisible()} onCheckedChange={() => col.toggleVisibility()} onClick={(e) => e.stopPropagation()} />
                  {allColNames[col.id] ?? col.id}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Group by day */}
        <Button
          variant={groupByDay ? 'default' : 'outline'}
          size="sm"
          className="h-9 text-xs"
          onClick={() => setGroupByDay((v) => !v)}
        >
          Group by day
        </Button>

        <span className="text-xs text-muted-foreground">{table.getFilteredRowModel().rows.length} loads</span>

        {/* Bulk actions */}
        {selectedRows.length > 0 && (
          <>
            <Separator orientation="vertical" className="h-5" />
            <Badge variant="secondary" className="text-xs">{selectedRows.length} selected</Badge>
            <Button type="button" variant="outline" size="sm" className="h-9 gap-1 text-xs" onClick={bulkMarkRTI}>
              <UserCheck className="size-3.5" /> Mark RTI
            </Button>
            <Select onValueChange={(driverId) => {
              selectedLoads.forEach((l) => updateLoad(l.id, { pickupDriverId: driverId, deliveryDriverId: driverId }))
              toast(`${selectedLoads.length} load(s) reassigned`)
              setRowSelection({})
            }}>
              <SelectTrigger className="h-9 w-36 text-xs"><SelectValue placeholder="Reassign to…" /></SelectTrigger>
              <SelectContent>
                {drivers.filter((d) => d.active).map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1 text-xs text-destructive border-destructive/30 hover:bg-destructive/5"
              onClick={bulkDelete}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        )}

        <div className="flex-1" />

        <Button type="button" size="lg" className="gap-1.5" onClick={() => setSelectedLoad(null, 'create')}>
          <Plus className="size-4" /> Add Load
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-background border-b border-border">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="text-left px-4 py-3 text-xs text-muted-foreground font-semibold uppercase tracking-wide whitespace-nowrap border-r border-border/50 last:border-r-0"
                    style={{ width: h.column.getSize() }}
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
                  <>
                    <tr key={`group-${day}`}>
                      <td
                        colSpan={table.getAllLeafColumns().length}
                        className="px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50 border-y border-border"
                      >
                        {day}
                      </td>
                    </tr>
                    {dayRows.map((row) => (
                      <GridRow key={row.id} row={row} onRowClick={() => setSelectedLoad(row.original.id, 'view')} />
                    ))}
                  </>
                ))
              : rows.map((row) => (
                  <GridRow key={row.id} row={row} onRowClick={() => setSelectedLoad(row.original.id, 'view')} />
                ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center">
                  {loads.length === 0 ? (
                    <div className="flex flex-col items-center gap-3">
                      <p className="text-muted-foreground text-sm">No loads yet.</p>
                      <Button type="button" size="sm" className="gap-1.5" onClick={() => setSelectedLoad(null, 'create')}>
                        <Plus className="size-3.5" /> Add your first load
                      </Button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">No loads match your search.</p>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <LoadDrawer />
    </div>
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
  return (
    <tr
      onClick={onRowClick}
      className={cn(
        'border-b border-border/50 cursor-pointer transition-colors',
        isRTI        ? 'bg-emerald-50 hover:bg-emerald-100/70' :
        isUnassigned ? 'bg-amber-50 hover:bg-amber-100/70' :
                       'hover:bg-slate-50',
        row.getIsSelected() && 'bg-primary/10 hover:bg-primary/15',
      )}
    >
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="px-4 py-3 border-r border-border/30 last:border-r-0">
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  )
}
