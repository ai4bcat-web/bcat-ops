import { useMemo, useState } from 'react'
import { Search, Link2, Unlink } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatDateShort } from '@/lib/date'
import { recentLoadsForDriver } from '@/lib/podDriver'
import type { Driver, Load } from '@/types'

function LoadRow({
  load,
  selected,
  onSelect,
}: {
  load: Load
  selected: boolean
  onSelect: (loadId: string) => void
}) {
  return (
    <button
      onClick={() => onSelect(load.id)}
      className={`w-full text-left px-4 py-3 border-b last:border-b-0 text-sm hover:bg-muted transition-colors ${
        selected ? 'bg-muted' : ''
      }`}
    >
      <div className="font-medium">{loadSummary(load)}</div>
    </button>
  )
}

function loadSummary(load: Load): string {
  const route = [load.originCity, load.destinationCity].filter(Boolean).join(' → ')
  const dates = [load.pickupAppt, load.deliveryAppt].filter(Boolean).map((d) => formatDateShort(d)).join(' → ')
  return [
    load.aljexId ? `Pro #${load.aljexId}` : '',
    load.tmsId ? `TMS/PO ${load.tmsId}` : '',
    load.customer || '',
    route,
    dates,
  ].filter(Boolean).join(' · ')
}

/**
 * Pick the load a document belongs to.
 *
 * Deliberately knows nothing about where the document came from. It is used for PODs
 * that arrived at JobsDone by text and for PODs a driver scanned in the PWA, and both
 * only need the same three things: which load is on it now, whose driver it is, and a
 * callback. Resolving the driver is the caller's job, because the two sources identify
 * one in completely different ways — a sender phone number versus a known driver id.
 */
export function AssignLoadDialog({
  assignedLoadId,
  driver,
  senderLabel,
  loads,
  onAssign,
  onUnassign,
  onClose,
}: {
  /** The load currently on the document, if any. */
  assignedLoadId?: string | null
  /** Whose document it is, when that is known. Their recent loads are offered first. */
  driver: Driver | null
  /** Who sent it, shown only when no driver could be resolved. */
  senderLabel?: string
  loads: Load[]
  onAssign: (loadId: string) => void
  onUnassign: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const current = useMemo(() => loads.find((l) => l.id === assignedLoadId), [loads, assignedLoadId])

  // The driver who sent this POD almost always delivered the load it belongs to, so
  // their recent deliveries come first; the full list stays one search away.
  const recent = useMemo(() => (driver ? recentLoadsForDriver(loads, driver.id) : []), [loads, driver])
  const recentIds = useMemo(() => new Set(recent.map((l) => l.id)), [recent])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rest = loads.filter((l) => !recentIds.has(l.id))
    if (!q) return rest
    return rest.filter((l) => {
      const hay = [
        l.aljexId, l.tmsId, l.pickupNumber, l.customer,
        l.originName, l.originCity, l.destinationName, l.destinationCity,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [loads, query, recentIds])

  const selectLoad = (loadId: string) => setSelected(loadId)

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign shipment</DialogTitle>
          <DialogDescription>
            Choose the load this POD belongs to. The source image and any existing scans are preserved.
          </DialogDescription>
        </DialogHeader>

        {current && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <div className="font-medium text-amber-900 mb-1">Currently assigned</div>
            <div className="text-amber-800">{loadSummary(current)}</div>
            <button
              onClick={() => {
                if (confirm('Unassign this POD from the load?')) {
                  onUnassign()
                  onClose()
                }
              }}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:text-red-800"
            >
              <Unlink size={13} /> Unassign
            </button>
          </div>
        )}

        <div className="max-h-96 overflow-y-auto border rounded-lg">
          {driver ? (
            <>
              <div className="px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/50 border-b">
                Recent deliveries by {driver.name}
              </div>
              {recent.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground border-b">No loads on record for {driver.name}.</div>
              ) : (
                recent.map((l) => <LoadRow key={l.id} load={l} selected={selected === l.id} onSelect={selectLoad} />)
              )}
            </>
          ) : (
            <div className="px-4 py-2 text-xs text-muted-foreground bg-muted/50 border-b">
              {senderLabel ? `Sender ${senderLabel} is not on the driver roster, so all loads are shown.` : 'No driver resolved, so all loads are shown.'}
            </div>
          )}

          <div className="px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/50 border-b border-t">
            {driver ? 'All other loads' : 'All loads'}
          </div>
          <div className="relative p-2 border-b">
            <Search size={14} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Pro #, TMS/PO, customer, city…"
              className="pl-9"
            />
          </div>
          {matches.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No loads match "{query}".
            </div>
          ) : (
            matches.map((l) => <LoadRow key={l.id} load={l} selected={selected === l.id} onSelect={selectLoad} />)
          )}
        </div>

        <DialogFooter>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-9 px-4 rounded-md border text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (selected) {
                const chosen = loads.find((l) => l.id === selected)
                if (chosen && confirm(`Assign this POD to ${chosen.aljexId ? `Pro #${chosen.aljexId}` : chosen.id.slice(-6)}?`)) {
                  onAssign(selected)
                  onClose()
                }
              }
            }}
            disabled={!selected}
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50"
          >
            <Link2 size={14} className="mr-1.5" /> Assign
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
