/**
 * Send Address Details (Ryne 2026-11-13): e-mail the carrier's dispatcher the load's stops —
 * addresses, appointments, hours, carrier-visible refs, contacts. No money, and it does not
 * dispatch the load. The preview is the same text the Lambda builds from the saved load.
 */
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { buildAddressDetailsEmail, type AddressDetailsStopInput } from '@/lib/addressDetailsEmail'
import { sendAddressDetails } from '@/lib/apiClient'
import { dedupeEmails, isEmailAddress } from '@/lib/emailAddress'
import { errorText } from '@/lib/errorText'
import type { LoadCarrierRecord, ShipmentLoad } from '@/types/tms'

const ALWAYS_CC = 'tracking@bcatcorp.com'

export function AddressDetailsDialog({ loadCarrier, load, defaultTo, onClose }: {
  loadCarrier: LoadCarrierRecord
  load: ShipmentLoad
  /** The booking's dispatcher e-mail, else the carrier's. Blank when neither is on file. */
  defaultTo: string
  onClose: () => void
}) {
  const [to, setTo] = useState<string[]>(() => (isEmailAddress(defaultTo.trim()) ? [defaultTo.trim()] : []))
  const [draft, setDraft] = useState('')
  const [cc, setCc] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = useMemo(() => {
    const l = load as ShipmentLoad & Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' ? v : null)
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
    return buildAddressDetailsEmail({
      pro: str(l.loadNumber) ?? '',
      carrierName: loadCarrier.carrierName ?? null,
      carrierRef: loadCarrier.tripNumber ?? null,
      equipment: str(l.equipmentType),
      commodity: str(l.commodity) ?? str(l.freightDescription),
      weightLbs: num(l.weight),
      pieces: num(l.pieces),
      piecesUnit: str(l.piecesUnit),
      stops: (Array.isArray(l.stops) ? l.stops : []) as AddressDetailsStopInput[],
    }).text
  }, [load, loadCarrier])

  const add = () => {
    const v = draft.trim()
    if (!v) return
    if (!isEmailAddress(v)) { setError(`${v} is not an e-mail address`); return }
    setTo((p) => dedupeEmails([...p, v]))
    setDraft('')
    setError(null)
  }

  const ccList = cc.split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean)
  const badCc = ccList.find((v) => !isEmailAddress(v))

  const send = async () => {
    if (to.length === 0) { setError('Add the dispatcher e-mail to send to'); return }
    if (badCc) { setError(`${badCc} is not an e-mail address`); return }
    setBusy(true)
    setError(null)
    try {
      const res = await sendAddressDetails({ loadCarrierId: loadCarrier.id, to, cc: ccList })
      toast.success(`Address details sent to ${res.to.join(', ')}`)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsDialog
      open onOpenChange={(v) => { if (!v && !busy) onClose() }} title="Send address details" className="max-w-2xl"
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => { void send() }} disabled={busy || to.length === 0} data-testid="address-details-send">
            {busy ? 'Sending…' : 'Send address details'}
          </TmsButton>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="tms-muted" style={{ margin: 0 }}>
          E-mails the dispatcher the pickup and delivery addresses, appointments, hours and reference numbers. No rates are included, and the load is not marked dispatched.
        </p>
        <TmsField label="Send to">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: to.length ? 6 : 0 }} data-testid="address-details-to">
            {to.map((e) => (
              <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--tms-border)', background: 'var(--tms-card)', fontSize: 12 }}>
                {e}
                <button type="button" aria-label={`Remove ${e}`} onClick={() => setTo((p) => p.filter((x) => x !== e))}
                  style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, color: 'inherit', display: 'inline-flex' }}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <TmsInput id="address-details-add" aria-label="Add an address" placeholder="Add another address" value={draft}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
            <TmsButton variant="secondary" onClick={add} disabled={!draft.trim()}>Add</TmsButton>
          </div>
        </TmsField>
        <TmsField label="CC">
          <TmsInput id="address-details-cc" aria-label="CC" placeholder="Optional, comma separated" value={cc} onChange={(e) => setCc(e.target.value)} />
        </TmsField>
        <div className="tms-muted" style={{ fontSize: 12 }}>Always on CC: {ALWAYS_CC} and you.</div>
        <TmsField label="Preview">
          <pre data-testid="address-details-preview" style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, padding: 10, border: '1px solid var(--tms-border)', borderRadius: 8, background: 'var(--tms-card)' }}>
            {preview}
          </pre>
        </TmsField>
        {error ? <TmsAlert tone="red">{error}</TmsAlert> : null}
      </div>
    </TmsDialog>
  )
}
