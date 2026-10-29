/**
 * Telling a carrier — or their factor — what we just sent them, and telling the truth
 * about whether the e-mail left the building.
 *
 * SES is denied outside production, so a send comes back NOT_SENT with the mail
 * service's own refusal and signed links to the bytes that would have gone out. Those
 * links last an hour. This dialog never says "sent" in that case: it says plainly that
 * nothing left, hands over the subject and body to paste into a mail client, offers the
 * attachment, and lets somebody who sent it another way record that fact with a note.
 *
 * The preview is `renderRemittanceEmail`, the same pure renderer the Lambda uses, so
 * what is read here is what is sent. It carries the reference, the date, the amount and
 * the bills — never a customer rate, a margin or a bank detail.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import {
  getCarrier,
  getTmsSettings,
  graphqlErrorText,
  listBillsByCarrier,
  listDivisions,
  markRemittanceSent,
  renderRemittancePdf,
  sendRemittance,
  type RemittanceEmailResult,
} from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { renderRemittanceEmail } from '@/lib/shipmentNotices'
import type { ApPaymentRecord, CarrierBillRecord } from '@/types/tms'

/** An editable list of addresses. Blank and duplicate entries are simply not added. */
function Recipients({ label, ariaLabel, emails, disabled, onChange }: {
  label: string
  ariaLabel: string
  emails: string[]
  disabled: boolean
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim().toLowerCase()
    setDraft('')
    if (!value || emails.includes(value)) return
    onChange([...emails, value])
  }

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider tms-muted">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {emails.map((email) => (
          <span
            key={email}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
            style={{ border: '1px solid var(--tms-border)' }}
          >
            {email}
            <button
              type="button"
              aria-label={`Remove ${email} from ${label}`}
              disabled={disabled}
              onClick={() => onChange(emails.filter((row) => row !== email))}
              className="tms-muted"
              style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <TmsInput
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        placeholder="add an address, then Enter"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        className="mt-1"
      />
    </div>
  )
}

export function SendRemittanceDialog({ payment, open, onOpenChange, onDone }: {
  payment: ApPaymentRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [bills, setBills] = useState<CarrierBillRecord[]>([])
  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [result, setResult] = useState<RemittanceEmailResult | null>(null)
  const [sentNote, setSentNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [marking, setMarking] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { id: paymentId, carrierId } = payment

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    Promise.all([listBillsByCarrier(carrierId), getTmsSettings(), listDivisions(), getCarrier(carrierId)])
      .then(([billRows, settings, divisions, carrier]) => {
        const billIds = (payment.applications ?? []).map((row) => row.billId)
        const settled = billRows.filter((row) => billIds.includes(row.id))
        const division = divisions.find((row) => row.key === settled[0]?.divisionKey) ?? null
        // Where the money went is where the advice goes: the factor when the bill was
        // assigned, the carrier otherwise.
        const payee = payment.remitTo?.payeeEmail ?? carrier?.email ?? null
        setBills(settled)
        setTo(payee ? [payee.trim().toLowerCase()] : [])
        setCc([])
        setPreview(renderRemittanceEmail({
          payment,
          bills: settled,
          carrierName: settled[0]?.carrierName ?? carrier?.name ?? null,
          template: settings?.remittanceEmailTemplate ?? null,
          brokerName: division?.name ?? division?.legalName ?? 'BCAT',
        }))
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [carrierId, payment])

  useEffect(() => { load() }, [load])

  const disabled = sending || marking || loading
  const notSent = result !== null && result.emailStatus !== 'SENT'

  const send = (via: 'EMAIL' | 'COPY') => {
    setSending(true)
    setError(null)
    sendRemittance({ paymentId, to, cc, via, message: message.trim() || undefined })
      .then((sent) => {
        setResult(sent)
        if (sent.emailStatus === 'SENT') toast.success(`Remittance e-mailed to ${sent.to.join(', ')}`)
        else toast.message('Nothing was sent — copy the body below')
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setSending(false))
  }

  const markSent = () => {
    setMarking(true)
    setError(null)
    markRemittanceSent({ paymentId, note: sentNote.trim() })
      .then(() => {
        toast.success('Recorded as sent by hand')
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setMarking(false))
  }

  /** The advice is rendered after the money moves, so a renderer that failed leaves
   *  a payment with no attachment. This is the repair, not a re-send. */
  const rebuild = () => {
    setRebuilding(true)
    setError(null)
    renderRemittancePdf({ paymentId })
      .then(() => {
        toast.success('Advice rebuilt')
        onDone()
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setRebuilding(false))
  }

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text)
      .then(() => toast.success(`${what} copied`))
      .catch(() => toast.error(`${what} could not be copied`))
  }

  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remittance ${payment.reference ?? payment.id} · ${formatCents(payment.amountCents)}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={() => onOpenChange(false)} disabled={sending || marking}>Close</TmsButton>
          <TmsButton onClick={() => send('COPY')} disabled={disabled}>Copy</TmsButton>
          <TmsButton variant="primary" onClick={() => send('EMAIL')} disabled={disabled || to.length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </TmsButton>
          {result && <TmsButton onClick={onDone}>Done</TmsButton>}
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading the payment…
        </p>
      )}

      {!loading && (
        <div className="flex flex-col gap-3">
          <Recipients label="To" ariaLabel="Remittance recipient" emails={to} disabled={disabled} onChange={setTo} />
          <Recipients label="CC" ariaLabel="Remittance CC" emails={cc} disabled={disabled} onChange={setCc} />
          {to.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--tms-badge-orange)' }}>
              Nobody is addressed. Put a remit-to e-mail on the carrier's payment method,
              or type an address above.
            </p>
          )}

          <p className="text-xs tms-muted">
            {bills.length === 0
              ? 'This payment names no bills, so the advice lists none.'
              : `Covers ${bills.length} ${bills.length === 1 ? 'bill' : 'bills'}.`}
          </p>
          {!payment.pdfKey && (
            <p className="flex items-center gap-2 text-xs" style={{ color: 'var(--tms-badge-orange)' }}>
              <AlertTriangle size={13} />
              The advice PDF was never stored, so this would go out with no attachment.
              <TmsButton size="sm" disabled={disabled || rebuilding} onClick={rebuild}>
                {rebuilding ? 'Rebuilding…' : 'Rebuild it'}
              </TmsButton>
            </p>
          )}

          <TmsField label="Message">
            <TmsTextarea
              aria-label="Remittance message"
              rows={2}
              value={message}
              disabled={disabled}
              placeholder="optional — replaces the covering line"
              onChange={(e) => setMessage(e.target.value)}
            />
          </TmsField>

          {preview && (
            <div className="p-2" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
              <p className="text-xs font-medium">{preview.subject}</p>
              <pre className="mt-1 whitespace-pre-wrap text-xs tms-muted">
                {message.trim() ? `${preview.body.split('\n')[0]}\n\n${message.trim()}` : preview.body}
              </pre>
            </div>
          )}

          {result && result.emailStatus === 'SENT' && (
            <p
              className="flex items-start gap-2 p-2 text-xs"
              style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
            >
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-green)' }} />
              Sent to {result.to.join(', ')}{result.cc.length > 0 ? ` (cc ${result.cc.join(', ')})` : ''}.
            </p>
          )}

          {notSent && result && (
            <div
              className="flex flex-col gap-2 p-2"
              style={{ border: '1px solid var(--tms-badge-orange)', borderRadius: 'var(--tms-radius)' }}
            >
              <p className="flex items-start gap-2 text-xs font-medium">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--tms-badge-orange)' }} />
                Nothing was sent. The payment is posted and the advice is on record, but no
                e-mail left this system. Copy the body below and send it yourself — the
                download links last one hour.
              </p>
              {result.emailError && (
                <p className="text-xs tms-muted">Mail service said: {result.emailError}</p>
              )}
              <div className="p-2" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
                <p className="text-xs font-medium">{result.subject}</p>
                <pre className="mt-1 whitespace-pre-wrap text-xs tms-muted">{result.body}</pre>
              </div>
              <div className="flex flex-wrap gap-2">
                <TmsButton size="sm" aria-label="Copy remittance subject" onClick={() => copy(result.subject, 'Subject')}>
                  <Copy size={12} /> Subject
                </TmsButton>
                <TmsButton size="sm" aria-label="Copy remittance body" onClick={() => copy(result.body, 'Body')}>
                  <Copy size={12} /> Body
                </TmsButton>
                <TmsButton
                  size="sm"
                  aria-label="Copy recipient addresses"
                  onClick={() => copy([...result.to, ...result.cc].join(', '), 'Addresses')}
                >
                  <Copy size={12} /> Addresses
                </TmsButton>
                {result.downloads.map((file) => (
                  <a
                    key={file.name}
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Download ${file.name}`}
                    className="tms-btn tms-btn-secondary tms-btn-sm"
                  >
                    <Download size={12} /> {file.name}
                  </a>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1">
                  <TmsField label="How it was sent">
                    <TmsInput
                      aria-label="How the remittance was sent"
                      value={sentNote}
                      disabled={disabled}
                      placeholder="e-mailed from Outlook, faxed, read out on the phone…"
                      onChange={(e) => setSentNote(e.target.value)}
                    />
                  </TmsField>
                </div>
                <TmsButton
                  size="sm"
                  aria-label="Mark remittance sent"
                  disabled={disabled || sentNote.trim().length === 0}
                  onClick={markSent}
                >
                  {marking ? 'Recording…' : 'Mark sent'}
                </TmsButton>
              </div>
            </div>
          )}

          {payment.markedSentAt && (
            <p className="text-xs tms-muted">
              Marked sent by hand on {payment.markedSentAt.slice(0, 10)} by {payment.markedSentBy ?? 'unknown'}
              {payment.markedSentNote ? ` — ${payment.markedSentNote}` : ''}.
            </p>
          )}

          {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
