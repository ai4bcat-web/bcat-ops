import { useState } from 'react'
import { useLoads } from '@/hooks/useLoads'
import { updateStop } from '@/lib/stops'
import { apptTypeAfterEdit } from '@/lib/apptQueue'
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

  const srcAppt = stop ? stop.appt : load[apptField]
  const srcType = stop ? stop.apptType : load[typeField]
  const initVal = srcAppt ? formatDateTimeInput(srcAppt) : ''

  // 'pending' is not a stored type — it IS `exact` with no time yet, which is how the
  // whole app already renders an unset appointment. Keeping it derived rather than adding
  // a fourth enum value means there is still exactly one representation of the state; a
  // second one would drift from the first, which is the bug class we just spent a day on.
  const isPending = (srcType ?? 'exact') === 'exact' && !apptHasTime(srcAppt)
  const [dateVal, setDateVal] = useState(initVal)
  const [typeVal, setTypeVal] = useState<ApptType | 'pending'>(isPending ? 'pending' : (srcType ?? 'exact'))
  const [saving,  setSaving]  = useState(false)

  const datePart = dateVal.slice(0, 10)
  const timePart = dateVal.slice(11, 16)
  const combineDateTime = (d: string, t: string) => (d && t ? `${d}T${t}` : d || '')

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

      if (stop) {
        const stopPatch: Partial<Stop> = { apptType: effectiveType }
        if (iso) stopPatch.appt = iso
        await updateLoad(load.id, { stops: updateStop(load, stop.id, stopPatch) })
      } else {
        const patch: Partial<Load> = { [typeField]: effectiveType }
        if (iso) patch[apptField] = iso
        await updateLoad(load.id, patch)
      }
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
        <option value="fcfs">FCFS</option>
        <option value="tbd">NEED (TBD)</option>
      </select>
      <div className="flex gap-1.5">
        <button
          disabled={saving}
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
