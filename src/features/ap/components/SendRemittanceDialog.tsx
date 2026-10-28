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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="mt-1 flex flex-wrap gap-1">
        {emails.map((email) => (
          <span key={email} className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
            {email}
            <button
              type="button"
              aria-label={`Remove ${email} from ${label}`}
              disabled={disabled}
              onClick={() => onChange(emails.filter((row) => row !== email))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <Input
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        placeholder="add an address, then Enter"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
        className="mt-1 h-9 text-sm"
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Remittance {payment.reference ?? payment.id} · {formatCents(payment.amountCents)}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Reading the payment…
          </p>
        )}

        {!loading && (
          <div className="space-y-3">
            <Recipients label="To" ariaLabel="Remittance recipient" emails={to} disabled={disabled} onChange={setTo} />
            <Recipients label="CC" ariaLabel="Remittance CC" emails={cc} disabled={disabled} onChange={setCc} />
            {to.length === 0 && (
              <p className="text-xs text-amber-600">
                Nobody is addressed. Put a remit-to e-mail on the carrier's payment method,
                or type an address above.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              {bills.length === 0
                ? 'This payment names no bills, so the advice lists none.'
                : `Covers ${bills.length} ${bills.length === 1 ? 'bill' : 'bills'}.`}
            </p>
            {!payment.pdfKey && (
              <p className="flex items-center gap-2 text-xs text-amber-600">
                <AlertTriangle size={13} />
                The advice PDF was never stored, so this would go out with no attachment.
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={disabled || rebuilding}
                  onClick={rebuild}
                >
                  {rebuilding ? 'Rebuilding…' : 'Rebuild it'}
                </Button>
              </p>
            )}

            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Message</Label>
              <Textarea
                aria-label="Remittance message"
                rows={2}
                value={message}
                disabled={disabled}
                placeholder="optional — replaces the covering line"
                onChange={(e) => setMessage(e.target.value)}
                className="text-sm"
              />
            </div>

            {preview && (
              <div className="rounded-lg border border-border bg-muted/30 p-2">
                <p className="text-xs font-medium">{preview.subject}</p>
                <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {message.trim() ? `${preview.body.split('\n')[0]}\n\n${message.trim()}` : preview.body}
                </pre>
              </div>
            )}

            {result && result.emailStatus === 'SENT' && (
              <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2 text-xs">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                Sent to {result.to.join(', ')}{result.cc.length > 0 ? ` (cc ${result.cc.join(', ')})` : ''}.
              </p>
            )}

            {notSent && result && (
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2">
                <p className="flex items-start gap-2 text-xs font-medium">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  Nothing was sent. The payment is posted and the advice is on record, but no
                  e-mail left this system. Copy the body below and send it yourself — the
                  download links last one hour.
                </p>
                {result.emailError && (
                  <p className="text-xs text-muted-foreground">Mail service said: {result.emailError}</p>
                )}
                <div className="rounded border border-border bg-background p-2">
                  <p className="text-xs font-medium">{result.subject}</p>
                  <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{result.body}</pre>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" aria-label="Copy remittance subject" onClick={() => copy(result.subject, 'Subject')}>
                    <Copy size={12} className="mr-1" /> Subject
                  </Button>
                  <Button size="sm" variant="outline" aria-label="Copy remittance body" onClick={() => copy(result.body, 'Body')}>
                    <Copy size={12} className="mr-1" /> Body
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="Copy recipient addresses"
                    onClick={() => copy([...result.to, ...result.cc].join(', '), 'Addresses')}
                  >
                    <Copy size={12} className="mr-1" /> Addresses
                  </Button>
                  {result.downloads.map((file) => (
                    <a
                      key={file.name}
                      href={file.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Download ${file.name}`}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                    >
                      <Download size={12} /> {file.name}
                    </a>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">How it was sent</Label>
                    <Input
                      aria-label="How the remittance was sent"
                      value={sentNote}
                      disabled={disabled}
                      placeholder="e-mailed from Outlook, faxed, read out on the phone…"
                      onChange={(e) => setSentNote(e.target.value)}
                      className="h-9 text-sm"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="Mark remittance sent"
                    disabled={disabled || sentNote.trim().length === 0}
                    onClick={markSent}
                  >
                    {marking ? 'Recording…' : 'Mark sent'}
                  </Button>
                </div>
              </div>
            )}

            {payment.markedSentAt && (
              <p className="text-xs text-muted-foreground">
                Marked sent by hand on {payment.markedSentAt.slice(0, 10)} by {payment.markedSentBy ?? 'unknown'}
                {payment.markedSentNote ? ` — ${payment.markedSentNote}` : ''}.
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending || marking}>Close</Button>
          <Button variant="outline" onClick={() => send('COPY')} disabled={disabled}>Copy</Button>
          <Button onClick={() => send('EMAIL')} disabled={disabled || to.length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
          {result && <Button variant="outline" onClick={onDone}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
