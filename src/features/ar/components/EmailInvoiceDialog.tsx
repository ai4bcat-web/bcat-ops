/**
 * Sending an issued invoice, and telling the truth about what happened to it.
 *
 * A `NOT_SENT` answer comes back with whatever the mail service said and signed links to
 * the bytes that would have gone out. That is not a failure to hide behind a red toast:
 * the dialog says plainly that nothing was sent, quotes the server's own `emailError`
 * rather than guessing at a cause it cannot know — SES is denied on dev, but a refused
 * address or an oversized attachment reads the same way here — hands over the subject
 * and body to paste into a mail client, and offers the attachments for download.
 * Nothing here ever claims a send the server did not make.
 *
 * The template preview is `renderInvoiceEmail` — the same pure renderer the Lambda uses
 * — so what is read here is what is sent, not an approximation of it.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import {
  emailInvoice,
  getInvoice,
  getTmsSettings,
  graphqlErrorText,
  listCustomers,
  listDivisions,
  type InvoiceEmailResult,
} from '@/lib/apiClient'
import { billingRecipients, formatCents, invoiceCcRecipients } from '@/lib/invoiceBuild'
import { renderInvoiceEmail } from '@/lib/shipmentNotices'
import type { InvoiceRecord } from '@/types/tms'

/** An editable list of addresses. Blank and duplicate entries are simply not added. */
function Chips({ label, ariaLabel, emails, disabled, onChange }: {
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

export function EmailInvoiceDialog({ invoiceId, busy, onClose, onDone }: {
  invoiceId: string
  busy?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [invoice, setInvoice] = useState<InvoiceRecord | null>(null)
  const [to, setTo] = useState<string[]>([])
  const [cc, setCc] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [result, setResult] = useState<InvoiceEmailResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Non-async on purpose: `react-hooks/set-state-in-effect` cannot see through an
  // `async` function, so every state write lives in an explicit promise chain.
  const load = useCallback(() =>
    Promise.all([getInvoice(invoiceId), listCustomers(), listDivisions(), getTmsSettings()])
      .then(([row, customers, divisions, settings]) => {
        if (!row) { setError('That invoice no longer exists.'); return }
        const customer = customers.find((c) => c.id === row.customerId) ?? null
        const division = divisions.find((d) => d.key === row.divisionKey) ?? null
        const addressees = billingRecipients(customer, row.billToId)
        setInvoice(row)
        setTo(addressees)
        setCc(invoiceCcRecipients(customer).filter((email) => !addressees.includes(email)))
        setPreview(renderInvoiceEmail({
          invoice: row,
          customerName: row.customerName ?? customer?.name ?? null,
          template: settings?.invoiceEmailTemplate ?? null,
          brokerName: division?.name ?? division?.legalName ?? 'BCAT',
        }))
        setError(null)
      })
      .catch((err: unknown) => { setError(graphqlErrorText(err)) })
      .finally(() => setLoading(false)),
  [invoiceId])

  useEffect(() => { load() }, [load])

  const disabled = busy === true || sending || loading
  const notSent = result !== null && result.emailStatus !== 'SENT'

  const send = (via: 'EMAIL' | 'COPY') => {
    setSending(true)
    setError(null)
    emailInvoice({ invoiceId, to, cc, via, message: message.trim() || undefined })
      .then((sent) => {
        setResult(sent)
        if (sent.emailStatus === 'SENT') toast.success(`Invoice e-mailed to ${sent.to.join(', ')}`)
        else toast.message('Nothing was sent — copy the body below')
      })
      .catch((err: unknown) => {
        const text = graphqlErrorText(err)
        setError(text)
        toast.error(text)
      })
      .finally(() => setSending(false))
  }

  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text)
      .then(() => toast.success(`${what} copied`))
      .catch(() => toast.error(`${what} could not be copied`))
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={`E-mail invoice ${invoice ? `${invoice.number} · ${formatCents(invoice.balanceCents)} due` : ''}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={sending}>Close</TmsButton>
          <TmsButton onClick={() => send('COPY')} disabled={disabled || !invoice}>Copy</TmsButton>
          <TmsButton variant="primary" onClick={() => send('EMAIL')} disabled={disabled || !invoice || to.length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </TmsButton>
          {result && <TmsButton onClick={onDone}>Done</TmsButton>}
        </>
      }
    >
      {loading && (
        <p className="flex items-center gap-2 tms-muted">
          <Loader2 size={14} className="animate-spin" /> Reading the invoice…
        </p>
      )}

      {!loading && invoice && (
        <div className="flex flex-col gap-3">
          <Chips label="To" ariaLabel="Invoice e-mail recipient" emails={to} disabled={disabled} onChange={setTo} />
          <Chips label="CC" ariaLabel="Invoice e-mail CC" emails={cc} disabled={disabled} onChange={setCc} />
          {to.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--tms-badge-orange)' }}>
              Nobody is addressed. Add a billing contact to the customer, or type an address above.
            </p>
          )}

          <TmsField label="Message">
            <TmsTextarea
              aria-label="Invoice e-mail message"
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
                Nothing was sent. The invoice is issued and recorded, but no e-mail left
                this system. Copy the body below and send it yourself.
              </p>
              {result.emailError && (
                <p className="text-xs tms-muted">Mail service said: {result.emailError}</p>
              )}
              <div className="p-2" style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}>
                <p className="text-xs font-medium">{result.subject}</p>
                <pre className="mt-1 whitespace-pre-wrap text-xs tms-muted">{result.body}</pre>
              </div>
              <div className="flex flex-wrap gap-2">
                <TmsButton size="sm" aria-label="Copy e-mail subject" onClick={() => copy(result.subject, 'Subject')}>
                  <Copy size={12} /> Subject
                </TmsButton>
                <TmsButton size="sm" aria-label="Copy e-mail body" onClick={() => copy(result.body, 'Body')}>
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
            </div>
          )}

          {error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{error}</p>}
        </div>
      )}
    </TmsDialog>
  )
}
