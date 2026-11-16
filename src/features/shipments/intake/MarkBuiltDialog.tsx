/**
 * "Already built" dialog (Ryne 2026-11-16): type the PRO the load was built as; the match preview shows customer, lane, pickup and
 * status, warns when it does not look like the e-mail, and links the two. A PRO another e-mail already points at needs a confirm.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsInput } from '@/features/tms/kit'
import { listShipmentsByNumber, markIntakeBuilt } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { intakeRowLabel } from '@/lib/intakeDuplicates'
import type { IntakeLoadRecord } from '@/types/intake'
import { isAlreadyLinkedError, markBuiltWarnings, pickShipmentForPro, type ProLookup } from './markBuilt'

export function MarkBuiltDialog({ row, open, onOpenChange, onLinked }: {
  row: IntakeLoadRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onLinked: (row: IntakeLoadRecord) => void
}) {
  const [pro, setPro] = useState('')
  const [lookup, setLookup] = useState<ProLookup>({ kind: 'empty' })
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [relinkMessage, setRelinkMessage] = useState<string | null>(null)

  function changePro(next: string) {
    setPro(next)
    setRelinkMessage(null)
    if (!next.trim()) { setLookup({ kind: 'empty' }); setChecking(false) } else setChecking(true)
  }

  useEffect(() => {
    const value = pro.trim()
    if (!value) return
    let live = true
    const t = window.setTimeout(() => {
      listShipmentsByNumber(value)
        .then((rows) => { if (live) setLookup(pickShipmentForPro(value, rows)) })
        .catch(() => { if (live) setLookup({ kind: 'notFound' }) })
        .finally(() => { if (live) setChecking(false) })
    }, 300)
    return () => { live = false; window.clearTimeout(t) }
  }, [pro])

  function close(next: boolean) {
    if (!next) { setPro(''); setLookup({ kind: 'empty' }); setRelinkMessage(null) }
    onOpenChange(next)
  }

  async function link(confirmRelink: boolean) {
    if (lookup.kind !== 'found') return
    setBusy(true)
    try {
      const done = await markIntakeBuilt({ intakeId: row.id, shipmentId: lookup.shipment.id, confirmRelink })
      toast.success(`Marked built as PRO ${lookup.shipment.number}`)
      close(false)
      onLinked(done)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not link'
      if (isAlreadyLinkedError(message)) setRelinkMessage(message.replace(/^ALREADY_LINKED:\s*/, ''))
      else toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const s = lookup.kind === 'found' ? lookup.shipment : null
  const warnings = s ? markBuiltWarnings(row, s) : []
  return (
    <TmsDialog
      open={open}
      onOpenChange={close}
      title="Already built?"
      description={`${intakeRowLabel(row)}. Enter the PRO you built it as; the e-mail leaves the queue and its documents go on that shipment.`}
      footer={(
        <div className="tms-intake-footer">
          <TmsButton size="sm" onClick={() => close(false)}>Cancel</TmsButton>
          {relinkMessage ? (
            <TmsButton size="sm" variant="primary" data-testid="intake-markbuilt-relink" disabled={busy} onClick={() => { void link(true) }}>Link anyway</TmsButton>
          ) : (
            <TmsButton size="sm" variant="primary" data-testid="intake-markbuilt-confirm" disabled={busy || !s} onClick={() => { void link(false) }}>
              {s ? `Mark built as ${s.number}` : 'Mark built'}
            </TmsButton>
          )}
        </div>
      )}
    >
      <div className="tms-intake-markbuilt" data-testid="intake-markbuilt">
        <label className="tms-intake-markbuilt-label" htmlFor={`intake-markbuilt-pro-${row.id}`}>PRO #</label>
        <TmsInput
          id={`intake-markbuilt-pro-${row.id}`}
          data-testid="intake-markbuilt-pro"
          inputMode="numeric"
          autoFocus
          value={pro}
          onChange={(e) => changePro(e.target.value)}
          placeholder="e.g. 20061"
        />
        {checking && lookup.kind !== 'empty' ? <p className="tms-intake-markbuilt-hint">Checking…</p> : null}
        {!checking && lookup.kind === 'notFound' ? <p className="tms-intake-markbuilt-hint is-bad">No shipment with that PRO.</p> : null}
        {!checking && lookup.kind === 'voided' ? <p className="tms-intake-markbuilt-hint is-bad">That PRO is voided.</p> : null}
        {s && !checking ? (
          <div className="tms-intake-markbuilt-match" data-testid="intake-markbuilt-match">
            <div><strong>PRO {s.number}</strong> <TmsBadge tone="gray">{String(s.status).replace(/_/g, ' ')}</TmsBadge></div>
            <div>{s.customerName ?? 'No customer'}</div>
            <div>{s.originCity ?? '—'} → {s.destinationCity ?? '—'}</div>
            <div>Pickup {s.pickupAppt ? formatDateTime(s.pickupAppt) : '—'}</div>
          </div>
        ) : null}
        {warnings.map((w) => <TmsAlert key={w} tone="orange">{w}</TmsAlert>)}
        {relinkMessage ? <TmsAlert tone="orange">{relinkMessage}</TmsAlert> : null}
      </div>
    </TmsDialog>
  )
}
