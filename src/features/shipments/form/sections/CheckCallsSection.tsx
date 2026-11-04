/**
 * Check Calls (AH-plan §4.12): the Aljex inline row + table. Adding a call is an immediate
 * action (`ctx.actions.addCheckCall`, LOG_CHECK_CALL); Temperature / Message / EDI Reason ride
 * inside the note (`checkCallNote.ts`) and are decoded again for the table.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { listCheckCallsByLoad } from '@/lib/apiClient'
import { formatDateTime, fromDateTimeInput } from '@/lib/date'
import type { LoadCheckCallRecord } from '@/types/tms'
import { CHECK_CALL_MESSAGES, EDI_REASONS, MAX, US_STATES } from '../constants'
import { decodeCheckCallNote, messageLabel } from '../checkCallNote'
import { LABEL } from '../labels'
import { emptyCheckCall, isLocked, lockReason } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { fieldAttrs } from './fieldAttrs'

const titleCase = (s: string) => s.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

function CheckCallsSectionImpl({ value, onChange, ctx, form }: SliceSectionProps<'checkCall'>) {
  const [rows, setRows] = useState<LoadCheckCallRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const load = ctx.bundle?.loads[0] ?? null
  const loadId = load?.id ?? null
  const stamp = load?.updatedAt ?? null
  const canceled = load?.status === 'CANCELED'
  const saved = ctx.mode === 'edit' && load != null
  const locked = isLocked(ctx.locked, 'checkCalls')
  const block = !saved ? 'Save the draft first'
    : canceled ? 'A canceled load takes no check calls'
    : locked ? lockReason(ctx.locked, 'checkCalls') ?? 'Check calls are locked'
    : null

  const reload = useCallback(async () => {
    if (!loadId) return
    try {
      const all = await listCheckCallsByLoad(loadId)
      setRows([...all].sort((a, b) => b.at.localeCompare(a.at)))
    } catch {
      /* keep the rows we had */
    }
  }, [loadId])

  // `stamp` re-reads after any bundle refresh (a call logged elsewhere moves the load).
  useEffect(() => {
    let live = true
    if (!loadId) return () => { live = false }
    listCheckCallsByLoad(loadId)
      .then((all) => { if (live) setRows([...all].sort((a, b) => b.at.localeCompare(a.at))) })
      .catch(() => {})
    return () => { live = false }
  }, [loadId, stamp])

  const set = (patch: Partial<typeof value>) => onChange(patch)

  const add = async () => {
    if (value.at && Date.parse(fromDateTimeInput(value.at)) > Date.now() + 60_000) {
      setError('A check call cannot be logged in the future')
      return
    }
    setError(null)
    setWorking(true)
    try {
      // Origin defaults to the carrier's until a call names its own place (read at click time).
      const origin = form.getValues().carrier
      await ctx.actions.addCheckCall({
        ...value,
        city: value.city.trim() || origin.originCity,
        state: value.state.trim() || origin.originState,
      })
      onChange(emptyCheckCall())
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The check call was not logged')
    } finally {
      setWorking(false)
    }
  }

  const disabled = ctx.busy || working

  return (
    <div className="space-y-3" data-testid="section-checkCalls-body">
      <div className="grid grid-cols-2 gap-2 min-[1500px]:grid-cols-5">
        <TmsField label={LABEL.checkCalls.city.text}>
          <TmsInput {...fieldAttrs(LABEL.checkCalls.city)} value={value.city} disabled={disabled} onChange={(e) => set({ city: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.checkCalls.state.text}>
          <TmsSelect
            {...fieldAttrs(LABEL.checkCalls.state)}
            value={value.state}
            placeholder=""
            disabled={disabled}
            onChange={(e) => set({ state: e.target.value })}
            options={US_STATES.map((s) => ({ value: s, label: s }))}
          />
        </TmsField>
        <TmsField label={LABEL.checkCalls.at.text}>
          <TmsInput {...fieldAttrs(LABEL.checkCalls.at)} type="datetime-local" value={value.at} disabled={disabled} onChange={(e) => set({ at: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.checkCalls.temperature.text}>
          <TmsInput {...fieldAttrs(LABEL.checkCalls.temperature)} inputMode="numeric" value={value.temperature} disabled={disabled} onChange={(e) => set({ temperature: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.checkCalls.message.text}>
          <TmsSelect
            {...fieldAttrs(LABEL.checkCalls.message)}
            value={value.message}
            placeholder=""
            disabled={disabled}
            onChange={(e) => set({ message: e.target.value })}
            options={CHECK_CALL_MESSAGES.map((m) => ({ value: m.code, label: m.label }))}
          />
        </TmsField>
        <TmsField label={LABEL.checkCalls.note.text}>
          <TmsInput {...fieldAttrs(LABEL.checkCalls.note)} maxLength={MAX.checkCallNote} value={value.note} disabled={disabled} onChange={(e) => set({ note: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.checkCalls.ediReason.text}>
          <TmsSelect
            {...fieldAttrs(LABEL.checkCalls.ediReason)}
            value={value.ediReason}
            placeholder=""
            disabled={disabled}
            onChange={(e) => set({ ediReason: e.target.value })}
            options={EDI_REASONS.map((r) => ({ value: r.code, label: r.label }))}
          />
        </TmsField>
        <TmsField label={LABEL.checkCalls.nextAt.text}>
          <TmsInput {...fieldAttrs(LABEL.checkCalls.nextAt)} type="datetime-local" value={value.nextAt} disabled={disabled} onChange={(e) => set({ nextAt: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.checkCalls.nextNote.text}>
          <TmsInput {...fieldAttrs(LABEL.checkCalls.nextNote)} value={value.nextNote} disabled={disabled} onChange={(e) => set({ nextNote: e.target.value })} />
        </TmsField>
        <div className="flex items-end">
          <TmsButton
            variant="primary"
            size="sm"
            data-testid={LABEL.checkCalls.add.testId}
            title={block ?? undefined}
            disabled={disabled || block != null}
            onClick={add}
          >
            {LABEL.checkCalls.add.text}
          </TmsButton>
        </div>
      </div>
      {block && <p className="tms-muted text-xs" data-testid="checkcall-block">{block}</p>}
      {error && <p className="text-xs" role="alert" data-testid="checkcall-error" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}

      {load?.nextCheckCallAt && <p className="text-xs" data-testid="checkcall-next-due">Next Check Call Due: {formatDateTime(load.nextCheckCallAt)}</p>}
      {load?.nextCheckCallNote && <p className="text-xs" data-testid="checkcall-next-note">Next Check Call Note: {load.nextCheckCallNote}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs" data-testid="checkcall-table">
          <thead>
            <tr>
              {['City', 'State', 'Reason', 'Temperature', 'Note', 'Entered By', 'Message', 'Check Call Date/Time', 'Created At'].map((h) => <th key={h}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="tms-muted">No check calls yet.</td></tr>
            )}
            {rows.map((r) => {
              const d = decodeCheckCallNote(r.note)
              const reason = d.ediReason ? EDI_REASONS.find((e) => e.code === d.ediReason)?.label ?? d.ediReason : ''
              return (
                <tr key={r.id} data-testid="checkcall-row">
                  <td>{r.city ?? ''}</td>
                  <td>{r.state ?? ''}</td>
                  <td>{reason}</td>
                  <td>{d.temperature != null ? `${d.temperature}°${d.unit ?? 'F'}` : ''}</td>
                  <td>{d.text}</td>
                  <td>{r.createdBy ?? ''}</td>
                  <td>{d.message ? messageLabel(d.message) : titleCase(r.type)}</td>
                  <td>{formatDateTime(r.at)}</td>
                  <td>{r.createdAt ? formatDateTime(r.createdAt) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export const CheckCallsSection = memo(CheckCallsSectionImpl)
