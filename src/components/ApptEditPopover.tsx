import { useState } from 'react'
import { useLoads } from '@/hooks/useLoads'
import { updateStop, getStops } from '@/lib/stops'
import { sendApptNotices } from '@/lib/sendApptNotices'
import { useAppStore } from '@/store/useAppStore'
import { apptTypeAfterEdit } from '@/lib/apptQueue'
import { canSetChangeNeeded, changeNeededPatch } from '@/lib/apptStatus'
import { formatDateTimeInput, fromDateTimeInput, fromDateInput, apptHasTime } from '@/lib/date'
import type { Load, Stop, ApptType } from '@/types'

/**
 * The one appointment editor, shared by the calendar and the Appts queue.
 *
 * Deliberately a single component rather than one per page: an appointment set on the
 * calendar and the same appointment set from the Appts queue must produce byte-identical
 * writes, or the two pages drift apart and "which screen did you book it on?" becomes a
 * real question. The Loads drawer edits the same fields through the same store action.
 *
 * `stop` is present in multi-stop mode and targets that one stop; without it the write
 * goes to the load's legacy pickup/delivery mirror fields.
 */
export function ApptEditPopover({ load, stop, apptField, typeField, onClose, className }: {
  load: Load
  stop?: Stop
  apptField: 'pickupAppt' | 'deliveryAppt'
  typeField: 'pickupApptType' | 'deliveryApptType'
  onClose: () => void
  /** Positioning override — the table cell anchors differently than the calendar row. */
  className?: string
}) {
  const { updateLoad } = useLoads()
  // The same identity the store stamps on writes and the audit log — not useAuth, which
  // would tie this leaf editor to the auth provider being mounted above it.
  const actor = useAppStore((s) => s.currentUserEmail)

  // Ranges can genuinely span days (there are multi-day windows in production), so the
  // end is a full date+time like the start — a time-only field would quietly collapse a
  // three-day window to one afternoon.
  const endField = apptField === 'pickupAppt' ? 'pickupApptEnd' : 'deliveryApptEnd'
  const srcAppt = stop ? stop.appt : load[apptField]
  const srcType = stop ? stop.apptType : load[typeField]
  const srcEnd = stop ? stop.apptEnd : load[endField]
  const initVal = srcAppt ? formatDateTimeInput(srcAppt) : ''
  const initEnd = srcEnd ? formatDateTimeInput(srcEnd) : ''

  // 'pending' is not a stored type — it IS `exact` with no time yet, which is how the
  // whole app already renders an unset appointment. Keeping it derived rather than adding
  // a fourth enum value means there is still exactly one representation of the state; a
  // second one would drift from the first, which is the bug class we just spent a day on.
  const isPending = (srcType ?? 'exact') === 'exact' && !apptHasTime(srcAppt)
  const [dateVal, setDateVal] = useState(initVal)
  const [typeVal, setTypeVal] = useState<ApptType | 'pending'>(isPending ? 'pending' : (srcType ?? 'exact'))
  const [endVal,  setEndVal]  = useState(initEnd)
  const [saving,  setSaving]  = useState(false)
  // CHANGE NEEDED — Ruben/Ryne only. Records the wanted date+time, restarts the
  // Batory ladder and clears every screenshot; Dennis re-earns REQUESTED → CONFIRMED.
  const [moveReq, setMoveReq] = useState(stop?.apptStatus === 'change_needed' || !!stop?.apptMoveRequested)
  const [changeTo, setChangeTo] = useState(stop?.apptChangeTo ? formatDateTimeInput(stop.apptChangeTo) : '')
  const canFlagMove = !!stop && (srcType ?? 'exact') !== 'tbd' && !isPending && canSetChangeNeeded(actor)

  const datePart = dateVal.slice(0, 10)
  const timePart = dateVal.slice(11, 16)
  const endDatePart = endVal.slice(0, 10)
  const endTimePart = endVal.slice(11, 16)
  const combineDateTime = (d: string, t: string) => (d && t ? `${d}T${t}` : d || '')

  const isRange = typeVal === 'range'
  // A window that ends before it starts would render as "16:00–08:00" and mean nothing.
  const badWindow = isRange && !!dateVal && !!endVal && endVal <= dateVal

  const commit = async () => {
    setSaving(true)
    try {
      // Choosing Pending means "no time yet" — drop the time rather than keeping a stale one.
      const pending = typeVal === 'pending'
      const chosen: ApptType = pending ? 'exact' : typeVal
      const value = pending ? dateVal.slice(0, 10) : dateVal
      const effectiveType = apptTypeAfterEdit(chosen, value, { type: srcType, value: initVal })

      // fromDateTimeInput, not `new Date(...).toISOString()`: the input is Chicago wall
      // time, and the native parse treats it as the BROWSER's zone — which writes the
      // wrong instant for anyone not sitting in Chicago.
      const iso = value
        ? (value.length > 10 ? fromDateTimeInput(value) : fromDateInput(value.slice(0, 10)))
        : ''

      // Decided before the write, against what was on screen.
      const prev = getStops(load)
      let next: Stop[]

      // The window end belongs to a range and nothing else — carrying a stale one onto an
      // exact appointment would leave apptTimeLabel rendering a window that no longer exists.
      const endIso = effectiveType === 'range' && endVal ? fromDateTimeInput(endVal) : undefined

      if (stop) {
        const stopPatch: Partial<Stop> = { apptType: effectiveType, apptEnd: endIso }
        if (canFlagMove) {
          const wasFlagged = stop.apptStatus === 'change_needed' || !!stop.apptMoveRequested
          if (moveReq && !wasFlagged) {
            Object.assign(stopPatch, changeNeededPatch(changeTo ? fromDateTimeInput(changeTo) : ''))
          } else if (!moveReq && wasFlagged) {
            stopPatch.apptMoveRequested = false
            stopPatch.apptChangeTo = null
          } else if (moveReq && changeTo) {
            stopPatch.apptChangeTo = fromDateTimeInput(changeTo)
          }
        }
        if (iso) stopPatch.appt = iso
        next = updateStop(load, stop.id, stopPatch)
        await updateLoad(load.id, { stops: next })
      } else {
        const patch: Partial<Load> = { [typeField]: effectiveType, [endField]: endIso }
        if (iso) patch[apptField] = iso
        await updateLoad(load.id, patch)
        // Legacy load: getStops synthesizes from the mirror fields, so read the result
        // back through it rather than hand-building the stop.
        next = getStops({ ...load, ...patch } as Load)
      }

      // Flagging NEED from the calendar or the Appts queue used to be silent — only the
      // Loads drawer notified. Same call, same rules, from every editor now.
      void sendApptNotices({ load, next, prev, actorName: actor, updateLoad })
    } finally { setSaving(false) }
    onClose()
  }

  const inputCls = "h-7 px-2 text-[11px] rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

  return (
    <div
      className={className ?? "absolute z-50 top-full left-0 mt-1 p-2.5 rounded-lg border border-border bg-popover text-popover-foreground shadow-xl flex flex-col gap-2"}
      style={{ width: 215 }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex gap-1">
        <input
          autoFocus
          type="date"
          aria-label="Appointment date"
          className={inputCls}
          style={{ flex: '1 1 0', minWidth: 0 }}
          value={datePart}
          onChange={(e) => setDateVal(combineDateTime(e.target.value, timePart))}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose() }}
        />
        <input
          type="text"
          placeholder="14:30"
          aria-label="Appointment time"
          className={inputCls}
          style={{ width: 60, flexShrink: 0 }}
          value={timePart}
          onChange={(e) => setDateVal(combineDateTime(datePart, e.target.value))}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose() }}
        />
      </div>
      <select
        className="w-full h-7 px-2 text-[11px] rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Appointment type"
        value={typeVal}
        onChange={(e) => {
          const v = e.target.value as ApptType | 'pending'
          setTypeVal(v)
          // Selecting Pending clears the time in the form too, so what you see is saved.
          if (v === 'pending') setDateVal(datePart)
        }}
      >
        <option value="exact">Exact Time</option>
        <option value="pending">Pending (no time set)</option>
        <option value="range">Window (range)</option>
        <option value="fcfs">FCFS</option>
        <option value="tbd">NEED (TBD)</option>
      </select>

      {canFlagMove && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer',
            color: moveReq ? '#b45309' : 'var(--ds-t3)', fontWeight: moveReq ? 700 : 500 }}>
            <input type="checkbox" checked={moveReq} onChange={(e) => setMoveReq(e.target.checked)}
              aria-label="Change needed" />
            CHANGE NEEDED{moveReq ? ' — task for Dennis, screenshots reset' : ''}
          </label>
          {moveReq && (
            <input
              type="datetime-local"
              aria-label="Change to date and time"
              className={inputCls}
              value={changeTo}
              onChange={(e) => setChangeTo(e.target.value)}
              title="The date and time you want instead"
            />
          )}
        </div>
      )}

      {isRange && (
        <>
          <div className="flex gap-1 items-center">
            <span className="text-[10px] text-muted-foreground shrink-0" style={{ width: 24 }}>ends</span>
            <input
              type="date"
              aria-label="Window end date"
              className={inputCls}
              style={{ flex: '1 1 0', minWidth: 0 }}
              value={endDatePart}
              onChange={(e) => setEndVal(combineDateTime(e.target.value, endTimePart || '00:00'))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !badWindow) commit(); if (e.key === 'Escape') onClose() }}
            />
            <input
              type="text"
              placeholder="17:00"
              aria-label="Window end time"
              className={inputCls}
              style={{ width: 56, flexShrink: 0 }}
              value={endTimePart}
              onChange={(e) => setEndVal(combineDateTime(endDatePart || datePart, e.target.value))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !badWindow) commit(); if (e.key === 'Escape') onClose() }}
            />
          </div>
          {badWindow && (
            <div className="text-[10px]" style={{ color: 'var(--ds-red)' }} role="alert">
              The window has to end after it starts.
            </div>
          )}
        </>
      )}
      <div className="flex gap-1.5">
        <button
          disabled={saving || badWindow}
          className="flex-1 h-6 text-[11px] font-medium rounded bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50 transition-colors"
          onClick={commit}
        >Save</button>
        <button
          className="flex-1 h-6 text-[11px] rounded border border-border hover:bg-accent text-muted-foreground transition-colors"
          onClick={onClose}
        >Cancel</button>
      </div>
    </div>
  )
}
