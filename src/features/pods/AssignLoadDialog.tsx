import { useMemo, useState } from 'react'
import { Search, Link2, Unlink } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatDateShort } from '@/lib/date'
import type { Load } from '@/types'
import type { PodDocument } from '@/types/pods'

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

export function AssignLoadDialog({
  doc,
  loads,
  onAssign,
  onUnassign,
  onClose,
}: {
  doc: PodDocument
  loads: Load[]
  onAssign: (doc: PodDocument, loadId: string) => void
  onUnassign: (doc: PodDocument) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const current = useMemo(() => loads.find((l) => l.id === doc.loadId), [loads, doc.loadId])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return loads
    return loads.filter((l) => {
      const hay = [
        l.aljexId, l.tmsId, l.pickupNumber, l.customer,
        l.originName, l.originCity, l.destinationName, l.destinationCity,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [loads, query])

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
                  onUnassign(doc)
                  onClose()
                }
              }}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:text-red-800"
            >
              <Unlink size={13} /> Unassign
            </button>
          </div>
        )}

        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Pro #, TMS/PO, customer, city…"
            className="pl-9"
          />
        </div>

        <div className="max-h-72 overflow-y-auto border rounded-lg">
          {matches.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No loads match "{query}".
            </div>
          ) : (
            matches.map((l) => (
              <button
                key={l.id}
                onClick={() => setSelected(l.id)}
                className={`w-full text-left px-4 py-3 border-b last:border-b-0 text-sm hover:bg-muted transition-colors ${
                  selected === l.id ? 'bg-muted' : ''
                }`}
              >
                <div className="font-medium">{loadSummary(l)}</div>
              </button>
            ))
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
                const chosen = matches.find((l) => l.id === selected)
                if (chosen && confirm(`Assign this POD to ${chosen.aljexId ? `Pro #${chosen.aljexId}` : chosen.id.slice(-6)}?`)) {
                  onAssign(doc, selected)
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
