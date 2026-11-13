/**
 * "Actual times" under a stop: when the truck arrived and left (for the last delivery: arrived and delivered). A person can type a time or
 * press Now; either saves at once through UPDATE_STOP / SET_TIMES (an actual time is a fact, not part of the big Save). The Ivan driver app and
 * the brokerage tracking link fill the same times in on their own, and the source is shown beside them; a time entered here is MANUAL and
 * is never overwritten by either.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { updateStop } from '@/lib/apiClient'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import { STOP_TIME_SOURCE_LABEL, stopTimesOf } from '@/lib/stopActualTimes'
import type { FormStop } from '../model'
import type { FormCtx } from '../sectionProps'
import { ColGroup } from '../fieldGrid'
import { DateTime24Input } from '../DateTime24Input'
import './stopActualTimes.css'

type Kind = 'arrivedAt' | 'departedAt'

export function StopActualTimes({ stop, ctx, onChange, isFinalDelivery, disabled }: {
  stop: FormStop
  ctx: FormCtx
  onChange: (patch: (prev: FormStop) => FormStop) => void
  isFinalDelivery: boolean
  disabled: boolean
}) {
  const bundle = ctx.mode === 'edit' ? ctx.bundle : null
  const load = bundle?.loads.find((l) => (l.stops ?? []).some((s) => s.id === stop.id)) ?? null
  const times = load ? stopTimesOf({ loads: [load] }).find((t) => t.stopId === stop.id) ?? null : null
  const [draft, setDraft] = useState<{ arrivedAt: string | null; departedAt: string | null }>({ arrivedAt: null, departedAt: null })
  const [busy, setBusy] = useState<Kind | null>(null)
  if (!bundle || !load) return null

  const saved: Record<Kind, string> = {
    arrivedAt: stop.arrivedAt ? formatDateTimeInput(stop.arrivedAt) : '',
    departedAt: stop.departedAt ? formatDateTimeInput(stop.departedAt) : '',
  }
  const shown = (k: Kind): string => draft[k] ?? saved[k]
  const labels: Record<Kind, string> = { arrivedAt: 'Arrived', departedAt: isFinalDelivery ? 'Delivered' : 'Departed' }
  const off = disabled || ctx.busy || busy !== null || Boolean(ctx.locked.voided)

  const save = async (kind: Kind, iso: string | null) => {
    setBusy(kind)
    try {
      const next = await updateStop({ loadId: load.id, expectedUpdatedAt: load.updatedAt ?? undefined, op: 'SET_TIMES', stopId: stop.id, patch: { [kind]: iso } })
      const fresh = next.loads.find((l) => l.id === load.id)?.stops?.find((s) => s.id === stop.id)
      onChange((prev) => ({
        ...prev,
        arrivedAt: fresh?.arrivedAt ?? '',
        departedAt: fresh?.departedAt ?? '',
        extra: { ...(prev.extra ?? {}), arrivedSource: fresh?.arrivedSource ?? null, departedSource: fresh?.departedSource ?? null },
      }))
      setDraft((d) => ({ ...d, [kind]: null }))
      toast.success(iso ? `${labels[kind]} time saved` : `${labels[kind]} time cleared`)
      await ctx.refreshBundle()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the time')
    } finally {
      setBusy(null)
    }
  }

  const row = (kind: Kind) => {
    const source = kind === 'arrivedAt' ? times?.arrivedSource : times?.departedSource
    const dirty = draft[kind] !== null && draft[kind] !== saved[kind]
    const testId = `stop-${stop.id}-${kind === 'arrivedAt' ? 'arrived' : 'departed'}`
    return (
      <div className="tms-stop-actual-row" key={kind}>
        <label className="tms-stop-actual-label" htmlFor={testId}>{labels[kind]}</label>
        <DateTime24Input
          inputProps={{ id: testId, 'data-testid': testId, 'aria-label': `${labels[kind]} date` }} value={shown(kind)} disabled={off}
          onChange={(v) => setDraft((d) => ({ ...d, [kind]: v }))}
        />
        <TmsButton size="sm" data-testid={`${testId}-now`} disabled={off} onClick={() => void save(kind, new Date().toISOString())}>Now</TmsButton>
        {dirty ? (
          <TmsButton size="sm" variant="primary" data-testid={`${testId}-save`} disabled={off || !shown(kind)} onClick={() => void save(kind, fromDateTimeInput(shown(kind)))}>Save</TmsButton>
        ) : null}
        {saved[kind] && !dirty ? (
          <TmsButton size="sm" variant="ghost" data-testid={`${testId}-clear`} disabled={off} onClick={() => void save(kind, null)} aria-label={`Clear ${labels[kind].toLowerCase()} time`}>Clear</TmsButton>
        ) : null}
        {saved[kind] && source ? <span className="tms-stop-actual-source tms-muted" data-testid={`${testId}-source`}>{STOP_TIME_SOURCE_LABEL[source]}</span> : null}
      </div>
    )
  }

  return (
    <ColGroup title="Actual times">
      <div className="tms-stop-actual" data-testid={`stop-${stop.id}-actual`}>
        {row('arrivedAt')}
        {row('departedAt')}
      </div>
    </ColGroup>
  )
}
