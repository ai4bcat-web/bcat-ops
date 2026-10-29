/**
 * What happened after the freight arrived: when it delivered, every e-mail the system
 * tried to send about it, whether the carrier has been asked for their paperwork, and
 * how they did.
 *
 * The notice list is the honest record of the outgoing mail. A row exists before SES is
 * called and keeps the rendered subject and body whatever SES said, so a NOT_SENT row
 * is something a person can copy out and send by hand rather than a message that
 * silently never happened. On dev SES is denied outright, which is why Copy body is the
 * button that gets used there.
 *
 * Own-fleet assignments get no rating block: a driver on our payroll is managed, not
 * scored, and `RATE_CARRIER` has nothing to write for them.
 */
import { useState } from 'react'
import { AlertTriangle, Check, Copy, PackageCheck, RotateCw, Send, Star } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsTextarea } from '@/features/tms/kit'
import { Label } from '@/components/ui/label'
import { rateCarrier, sendMilestoneNotice, sendUploadLink } from '@/lib/apiClient'
import { MILESTONE_LABELS } from '@/lib/shipmentNotices'
import { formatDateTime } from '@/lib/date'
import { useShipmentNotices } from '@/hooks/useShipmentNotices'
import type { ShipmentBundle, ShipmentNoticeRecord } from '@/types/tms'

const NOTICE_KIND_LABELS: Record<ShipmentNoticeRecord['kind'], string> = {
  MILESTONE: 'Milestone',
  POD_REQUEST: 'Paperwork request',
  DOCUMENTS: 'Documents',
  INVOICE: 'Invoice',
  REMITTANCE: 'Remittance',
  CARRIER_OFFER: 'Carrier offer request',
}

export function DeliveryCard({ bundle, onReload }: {
  bundle: ShipmentBundle
  /** A rating and a resend both write rows the summary above is reading. */
  onReload: () => Promise<void>
}) {
  const notices = useShipmentNotices(bundle.shipment.id)
  const [stars, setStars] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const delivered = bundle.loads
    .map((l) => l.deliveredAt)
    .filter((at): at is string => !!at)
    .sort()
  const assignment = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null
  const outside = assignment && assignment.kind !== 'OWN_ASSET' ? assignment : null
  const podRequest = notices.notices.find((n) => n.kind === 'POD_REQUEST') ?? null

  // Nothing has arrived yet, so there is nothing to report on.
  if (delivered.length === 0) return null

  const rate = async () => {
    if (!outside || stars == null) return
    setBusy('rate')
    setError(null)
    try {
      await rateCarrier({ loadCarrierId: outside.id, stars, note: note.trim() || undefined })
      await onReload()
      toast.success('Carrier rated')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The rating could not be saved')
    } finally {
      setBusy(null)
    }
  }

  const resend = async (notice: ShipmentNoticeRecord) => {
    setBusy(notice.id)
    setError(null)
    try {
      if (notice.kind === 'MILESTONE' && notice.milestone) {
        const answer = await sendMilestoneNotice({
          shipmentId: bundle.shipment.id,
          milestone: notice.milestone,
          via: 'EMAIL',
        })
        if (answer.emailStatus !== 'SENT') {
          setError(answer.emailError ?? 'Nothing was e-mailed — copy the message and send it by hand.')
        } else {
          toast.success(`Sent to ${answer.to.join(', ')}`)
        }
      } else if (notice.kind === 'POD_REQUEST' && notice.loadCarrierId) {
        const answer = await sendUploadLink({ loadCarrierId: notice.loadCarrierId, via: 'EMAIL' })
        if (answer.emailStatus !== 'SENT') {
          setError(answer.emailError ?? 'Nothing was e-mailed — copy the upload link and send it by hand.')
        } else {
          toast.success('Paperwork request sent')
        }
      }
      await notices.refresh()
      await onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be sent again')
    } finally {
      setBusy(null)
    }
  }

  return (
    <TmsCard title="Delivery">
      <div className="space-y-3 text-sm" data-testid="delivery-card">
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck size={14} className="text-[color:var(--tms-badge-green)]" />
        <p className="font-medium">Delivered {formatDateTime(delivered[delivered.length - 1])}</p>
        {delivered.length > 1 && (
          <TmsBadge tone="gray" className="text-[10px]">{delivered.length} legs</TmsBadge>
        )}
      </div>

      <div>
        <p className="text-xs uppercase tracking-wider tms-muted">Paperwork request</p>
        {outside ? (
          <p className="mt-0.5">
            {outside.podRequestedAt
              ? `Asked ${formatDateTime(outside.podRequestedAt)}${podRequest ? ` · ${podRequest.to}` : ''}`
              : 'The carrier has not been asked for their paperwork yet.'}
          </p>
        ) : (
          <p className="mt-0.5 tms-muted">
            Our own driver — the paperwork comes through the driver app.
          </p>
        )}
      </div>

      <div>
        <p className="text-xs uppercase tracking-wider tms-muted">
          E-mails{notices.failedCount > 0 ? ` · ${notices.failedCount} not sent` : ''}
        </p>
        {notices.loading && notices.notices.length === 0 && (
          <p className="mt-0.5 tms-muted">Reading the e-mail history…</p>
        )}
        {!notices.loading && notices.notices.length === 0 && (
          <p className="mt-0.5 tms-muted">Nothing has been sent about this shipment.</p>
        )}
        <ul className="mt-1 space-y-1">
          {notices.notices.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2 rounded-md border border-[color:var(--tms-border)] px-2 py-1.5">
              <TmsBadge tone="gray" className="text-[10px]">
                {NOTICE_KIND_LABELS[n.kind]}
                {n.milestone ? ` · ${MILESTONE_LABELS[n.milestone]}` : ''}
              </TmsBadge>
              <span className="min-w-0 flex-1 truncate text-xs">{n.to}</span>
              <span className="flex items-center gap-1 text-[11px]">
                {n.status === 'SENT' && <><Check size={12} className="text-[color:var(--tms-badge-green)]" />sent</>}
                {n.status === 'COPY' && <>copy only</>}
                {(n.status === 'NOT_SENT' || n.status === 'FAILED') && (
                  <>
                    <AlertTriangle size={12} className="text-[color:var(--tms-badge-orange)]" />
                    not sent{n.error ? ` — ${n.error}` : ''}
                  </>
                )}
              </span>
              <TmsButton size="sm" className="h-7"
                onClick={() => { void navigator.clipboard?.writeText(n.body); toast.success('Message copied') }}
              >
                <Copy size={13} className="mr-1" />Copy body
              </TmsButton>
              {(n.kind === 'MILESTONE' || n.kind === 'POD_REQUEST') && (
                <TmsButton size="sm" className="h-7"
                  disabled={busy !== null}
                  onClick={() => { void resend(n) }}
                >
                  {busy === n.id ? <RotateCw size={13} className="mr-1 animate-spin" /> : <Send size={13} className="mr-1" />}
                  Resend
                </TmsButton>
              )}
            </li>
          ))}
        </ul>
      </div>

      {outside && (
        <div>
          <p className="text-xs uppercase tracking-wider tms-muted">Rate this carrier</p>
          {outside.ratedAt && (
            <p className="mt-0.5 text-xs tms-muted">
              Rated {outside.ratingStars}★ on {formatDateTime(outside.ratedAt)}
              {outside.ratingNote ? ` · ${outside.ratingNote}` : ''}
            </p>
          )}
          <div className="mt-1 flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                aria-pressed={(stars ?? outside.ratingStars ?? 0) >= n}
                onClick={() => setStars(n)}
                disabled={busy !== null}
                className="tms-muted disabled:opacity-50"
              >
                <Star
                  size={18}
                  className={(stars ?? outside.ratingStars ?? 0) >= n ? 'fill-amber-400 text-[color:var(--tms-badge-orange)]' : ''}
                />
              </button>
            ))}
          </div>
          <div className="mt-2">
            <Label className="tms-field-label">Note</Label>
            <TmsTextarea
              aria-label="Rating note"
              rows={2}
              placeholder="What the next booker should know"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="text-sm"
            />
          </div>
          <TmsButton variant="primary"
            size="sm" className="mt-2"
            disabled={busy !== null || stars == null}
            onClick={() => { void rate() }}
          >
            {busy === 'rate' ? 'Saving…' : 'Save rating'}
          </TmsButton>
        </div>
      )}

      {error && (
        <p className="flex items-start gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-badge-red)]  p-2 text-xs text-[color:var(--tms-badge-red)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}
        </p>
      )}
      </div>
    </TmsCard>
  )
}
