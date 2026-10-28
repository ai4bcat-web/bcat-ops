/**
 * The stop cards on a shipment's load — one card per stop, in route order, each with the
 * MVMNT stop menu (spec §6.4 "Locations & stops"). The card is a renderer: every menu
 * item opens a small dialog and hands the parent one `UPDATE_STOP` op, so all the rules
 * (never below one pickup + one delivery, status advance from in/out times, legacy
 * mirrors) stay server-side where the Lambda enforces them.
 */
import { useState } from 'react'
import { MoreHorizontal, MapPin, Plus, ArrowUpDown, Trash2, Clock, CalendarClock, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatDateTime, formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import type { Stop, StopType } from '@/types'
import type { LocationRecord } from '@/types/tms'

export type StopOp =
  | 'ADD' | 'REMOVE' | 'SWAP' | 'SET_APPT' | 'SET_REQUESTED' | 'SET_TIMES' | 'SET_TYPE' | 'SET_REFS' | 'SET_LOCATION'

export interface StopActionInput {
  op: StopOp
  stopId?: string
  patch: Record<string, unknown>
}

interface StopCardsProps {
  stops: Stop[]
  locations: LocationRecord[]
  /** Canceled / delivered shipments show the cards but refuse every edit. */
  readOnly?: boolean
  onAction: (input: StopActionInput) => Promise<void> | void
}

/** Which dialog is open, and for which stop. `null` = none. */
type DialogState = { op: StopOp; stop?: Stop } | null

const APPT_REQUESTED_BY: { value: string; label: string }[] = [
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'CARRIER', label: 'Carrier' },
  { value: 'BROKER', label: 'Broker' },
]

function StopCard({ stop, index, total, readOnly, onOpen, onSwap, onRemove }: {
  stop: Stop
  index: number
  total: number
  readOnly?: boolean
  onOpen: (op: StopOp, stop: Stop) => void
  onSwap: (stop: Stop, direction: -1 | 1) => void
  onRemove: (stop: Stop) => void
}) {
  const isPickup = stop.type === 'pickup'
  const requested = stop.requestedStart
    ? `${formatDateTime(stop.requestedStart)}${stop.requestedEnd ? ` – ${formatDateTime(stop.requestedEnd)}` : ''}`
    : null

  return (
    <div
      data-testid={`stop-card-${stop.id}`}
      className="rounded-lg border border-border bg-card p-3"
    >
      <div className="flex items-start gap-3">
        <Badge className={isPickup ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'}>
          {isPickup ? 'PU' : 'DEL'} {index + 1}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{stop.name || 'Unnamed stop'}</p>
          <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <MapPin size={12} /> {stop.city || 'No city'}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div>
              <dt className="text-muted-foreground">Appointment</dt>
              <dd>{stop.appt ? formatDateTime(stop.appt) : '—'}{stop.apptType && stop.apptType !== 'exact' ? ` (${stop.apptType.toUpperCase()})` : ''}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requested</dt>
              <dd>{requested ?? '—'}{stop.apptRequestedBy ? ` · by ${stop.apptRequestedBy.toLowerCase()}` : ''}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">In</dt>
              <dd>{stop.arrivedAt ? formatDateTime(stop.arrivedAt) : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Out</dt>
              <dd>{stop.departedAt ? formatDateTime(stop.departedAt) : '—'}</dd>
            </div>
          </dl>
          {stop.refs && stop.refs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {stop.refs.map((r, i) => (
                <Badge key={`${r.code}-${i}`} variant="outline" className="text-[10px]">
                  {r.label || r.code}: {r.value}
                </Badge>
              ))}
            </div>
          )}
          {stop.apptNote && <p className="mt-2 text-xs text-muted-foreground">Appt: {stop.apptNote}</p>}
          {stop.stopNotes && <p className="mt-1 text-xs text-muted-foreground">{stop.stopNotes}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Stop ${index + 1} actions`} disabled={readOnly}>
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={() => onOpen('SET_APPT', stop)}>
              <CalendarClock size={14} className="mr-2" />{stop.appt ? 'Change appointment' : 'Schedule appointment'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('SET_REQUESTED', stop)}>
              <Clock size={14} className="mr-2" />Change requested time
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('SET_TIMES', stop)}>
              <Clock size={14} className="mr-2" />Add In/Out times
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOpen('SET_LOCATION', stop)}>
              <MapPin size={14} className="mr-2" />Change location
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('SET_REFS', stop)}>
              <Tag size={14} className="mr-2" />References &amp; notes
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen('SET_TYPE', stop)}>
              <ArrowUpDown size={14} className="mr-2" />Change stop type
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={index === 0} onSelect={() => onSwap(stop, -1)}>
              <ArrowUpDown size={14} className="mr-2" />Swap with previous
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === total - 1} onSelect={() => onSwap(stop, 1)}>
              <ArrowUpDown size={14} className="mr-2" />Swap with next
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => onRemove(stop)}>
              <Trash2 size={14} className="mr-2" />Delete stop
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function StopCards({ stops, locations, readOnly, onAction }: StopCardsProps) {
  const [dialog, setDialog] = useState<DialogState>(null)
  const [busy, setBusy] = useState(false)
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)

  // `onAction` toasts its own failure; swallowing it here keeps the dialog open and
  // stops the menu's fire-and-forget call from rejecting unhandled.
  const run = async (input: StopActionInput) => {
    setBusy(true)
    try {
      await onAction(input)
      setDialog(null)
    } catch {
      /* already reported */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {ordered.length === 0 && <p className="text-xs text-muted-foreground">No stops on this load.</p>}
      {ordered.map((stop, i) => (
        <StopCard
          key={stop.id}
          stop={stop}
          index={i}
          total={ordered.length}
          readOnly={readOnly}
          onOpen={(op, s) => setDialog({ op, stop: s })}
          onSwap={(s, dir) => {
            const other = ordered[ordered.indexOf(s) + dir]
            if (other) run({ op: 'SWAP', stopId: s.id, patch: { withStopId: other.id } })
          }}
          onRemove={(s) => run({ op: 'REMOVE', stopId: s.id, patch: {} })}
        />
      ))}
      <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => setDialog({ op: 'ADD' })}>
        <Plus size={14} className="mr-1" /> Additional stop
      </Button>

      {dialog && (
        <StopDialog
          state={dialog}
          locations={locations}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={run}
        />
      )}
    </div>
  )
}

function StopDialog({ state, locations, busy, onClose, onSubmit }: {
  state: NonNullable<DialogState>
  locations: LocationRecord[]
  busy: boolean
  onClose: () => void
  onSubmit: (input: StopActionInput) => void
}) {
  const { op, stop } = state
  const [appt, setAppt] = useState(stop?.appt ? formatDateTimeInput(stop.appt) : '')
  const [requestedStart, setRequestedStart] = useState(stop?.requestedStart ? formatDateTimeInput(stop.requestedStart) : '')
  const [requestedEnd, setRequestedEnd] = useState(stop?.requestedEnd ? formatDateTimeInput(stop.requestedEnd) : '')
  const [requestedBy, setRequestedBy] = useState(stop?.apptRequestedBy ?? '')
  const [apptNote, setApptNote] = useState(stop?.apptNote ?? '')
  const [stopNotes, setStopNotes] = useState(stop?.stopNotes ?? '')
  const [arrivedAt, setArrivedAt] = useState(stop?.arrivedAt ? formatDateTimeInput(stop.arrivedAt) : '')
  const [departedAt, setDepartedAt] = useState(stop?.departedAt ? formatDateTimeInput(stop.departedAt) : '')
  const [locationId, setLocationId] = useState(stop?.locationId ?? '')
  const [stopType, setStopType] = useState<StopType>(stop?.type ?? 'pickup')
  const [refsText, setRefsText] = useState((stop?.refs ?? []).map((r) => `${r.code}=${r.value}`).join('\n'))
  const [error, setError] = useState<string | null>(null)

  const titles: Record<StopOp, string> = {
    ADD: 'Additional stop',
    REMOVE: 'Delete stop',
    SWAP: 'Swap stops',
    SET_APPT: stop?.appt ? 'Change appointment' : 'Schedule appointment',
    SET_REQUESTED: 'Change requested time',
    SET_TIMES: 'In / Out times',
    SET_TYPE: 'Change stop type',
    SET_REFS: 'References & notes',
    SET_LOCATION: 'Change location',
  }

  const submit = () => {
    setError(null)
    if (op === 'SET_APPT') {
      if (!appt) { setError('Pick an appointment date and time.'); return }
      onSubmit({ op, stopId: stop?.id, patch: { appt: fromDateTimeInput(appt), apptRequestedBy: requestedBy || undefined, apptNote: apptNote || undefined } })
      return
    }
    if (op === 'SET_REQUESTED') {
      if (!requestedStart) { setError('Pick a requested start.'); return }
      if (requestedEnd && requestedEnd < requestedStart) { setError('Requested end is before the start.'); return }
      onSubmit({
        op, stopId: stop?.id,
        patch: {
          requestedStart: fromDateTimeInput(requestedStart),
          requestedEnd: requestedEnd ? fromDateTimeInput(requestedEnd) : null,
          apptRequestedBy: requestedBy || undefined,
          apptNote: apptNote || undefined,
        },
      })
      return
    }
    if (op === 'SET_TIMES') {
      if (!arrivedAt && !departedAt) { setError('Enter an in time, an out time, or both.'); return }
      if (arrivedAt && departedAt && departedAt < arrivedAt) { setError('Out time is before the in time.'); return }
      onSubmit({
        op, stopId: stop?.id,
        patch: {
          arrivedAt: arrivedAt ? fromDateTimeInput(arrivedAt) : null,
          departedAt: departedAt ? fromDateTimeInput(departedAt) : null,
        },
      })
      return
    }
    if (op === 'SET_LOCATION' || op === 'ADD') {
      if (!locationId) { setError('Pick a location.'); return }
      const location = locations.find((l) => l.id === locationId)
      const patch: Record<string, unknown> = {
        locationId,
        name: location?.name,
        city: location?.city && location?.state ? `${location.city}, ${location.state}` : location?.city,
      }
      if (op === 'ADD') {
        if (!appt) { setError('Pick an appointment date and time.'); return }
        patch.type = stopType
        patch.appt = fromDateTimeInput(appt)
      }
      onSubmit({ op, stopId: stop?.id, patch })
      return
    }
    if (op === 'SET_TYPE') {
      onSubmit({ op, stopId: stop?.id, patch: { type: stopType } })
      return
    }
    if (op === 'SET_REFS') {
      const refs = refsText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const [code, ...rest] = line.split('=')
        return { code: code.trim(), value: rest.join('=').trim(), level: 'STOP' as const, visibility: 'ALL' as const }
      })
      if (refs.some((r) => !r.code || !r.value)) { setError('Each reference needs CODE=value.'); return }
      onSubmit({ op, stopId: stop?.id, patch: { refs, stopNotes: stopNotes || null } })
    }
  }

  const needsLocation = op === 'ADD' || op === 'SET_LOCATION'
  const needsType = op === 'ADD' || op === 'SET_TYPE'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{titles[op]}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {needsType && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Stop type</Label>
              <select
                aria-label="Stop type"
                value={stopType}
                onChange={(e) => setStopType(e.target.value as StopType)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="pickup">Pick-up</option>
                <option value="delivery">Delivery</option>
              </select>
            </div>
          )}
          {needsLocation && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Location</Label>
              <select
                aria-label="Location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— select —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} — {l.city}, {l.state}</option>
                ))}
              </select>
            </div>
          )}
          {(op === 'SET_APPT' || op === 'ADD') && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Appointment</Label>
              <Input aria-label="Appointment" type="datetime-local" value={appt} onChange={(e) => setAppt(e.target.value)} className="h-9 text-sm" />
            </div>
          )}
          {(op === 'SET_REQUESTED') && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Requested from</Label>
                <Input aria-label="Requested from" type="datetime-local" value={requestedStart} onChange={(e) => setRequestedStart(e.target.value)} className="h-9 text-sm" />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Requested to</Label>
                <Input aria-label="Requested to" type="datetime-local" value={requestedEnd} onChange={(e) => setRequestedEnd(e.target.value)} className="h-9 text-sm" />
              </div>
            </div>
          )}
          {(op === 'SET_APPT' || op === 'SET_REQUESTED') && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Requested by</Label>
              <select
                aria-label="Requested by"
                value={requestedBy}
                onChange={(e) => setRequestedBy(e.target.value as typeof requestedBy)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">— not stated —</option>
                {APPT_REQUESTED_BY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          {op === 'SET_TIMES' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">In</Label>
                <Input aria-label="In time" type="datetime-local" value={arrivedAt} onChange={(e) => setArrivedAt(e.target.value)} className="h-9 text-sm" />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Out</Label>
                <Input aria-label="Out time" type="datetime-local" value={departedAt} onChange={(e) => setDepartedAt(e.target.value)} className="h-9 text-sm" />
              </div>
            </div>
          )}
          {op === 'SET_REFS' && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">References — one CODE=value per line</Label>
              <Textarea aria-label="References" rows={4} value={refsText} onChange={(e) => setRefsText(e.target.value)} className="text-sm" />
            </div>
          )}
          {(op === 'SET_APPT' || op === 'SET_REQUESTED') && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Appointment note</Label>
              <Textarea aria-label="Appointment note" rows={2} value={apptNote} onChange={(e) => setApptNote(e.target.value)} className="text-sm" />
            </div>
          )}
          {op === 'SET_REFS' && (
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Stop notes</Label>
              <Textarea aria-label="Stop notes" rows={2} value={stopNotes} onChange={(e) => setStopNotes(e.target.value)} className="text-sm" />
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
