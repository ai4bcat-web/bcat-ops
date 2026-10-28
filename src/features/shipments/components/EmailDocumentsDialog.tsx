/**
 * E-mail documents off the shipment, to the customer or to the carrier.
 *
 * Two things this dialog refuses to do. It never offers a row the recipient may not
 * have — `canEmailTo` decides, and the rows it refuses are shown greyed with the reason
 * rather than hidden, so nobody wonders where the POD went. And it never claims a
 * message went out: when SES is denied (which is every send on dev) the answer comes
 * back NOT_SENT with presigned download links, and those links are what is shown.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, Mail, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { emailDocuments, type EmailDocumentsResult } from '@/lib/apiClient'
import { canEmailTo, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { renderDocumentsEmail } from '@/lib/shipmentNotices'
import type { CustomerRecord, ShipmentBundle, ShipmentDocumentRecord } from '@/types/tms'

type RecipientKind = 'CUSTOMER' | 'CARRIER'

/** Why a row cannot go to this recipient, in the words the office would use. */
function refusal(doc: ShipmentDocumentRecord, kind: RecipientKind): string | null {
  if (canEmailTo(doc, kind)) return null
  if (doc.status === 'SUPERSEDED') return 'superseded by a newer version'
  if (doc.status === 'VOID') return 'voided'
  if (doc.reviewStatus === 'PENDING') return 'still waiting to be reviewed'
  if (doc.reviewStatus === 'REJECTED') return 'was rejected'
  if (doc.audience === 'INTERNAL') return 'internal — it never leaves the building'
  return doc.audience === 'CUSTOMER' ? 'customer paperwork' : 'carrier paperwork'
}

export function EmailDocumentsDialog({
  bundle, customer, documents, brokerName, senderName, onClose, onSent,
}: {
  bundle: ShipmentBundle
  customer: CustomerRecord | null
  /** Every row on the shipment; what may be sent is decided here, not by the caller. */
  documents: ShipmentDocumentRecord[]
  brokerName: string
  senderName: string
  onClose: () => void
  /** A notice row was written: the tab re-reads its e-mail history. */
  onSent: () => void
}) {
  const assignment = bundle.loadCarriers.find((c) => c.status === 'ACTIVE') ?? null

  const [kind, setKind] = useState<RecipientKind>('CUSTOMER')
  const [selected, setSelected] = useState<string[]>([])
  // Null until edited, so switching the recipient re-reads the right address book
  // instead of mailing the carrier whatever the customer's contacts were.
  const [toOverride, setToOverride] = useState<string | null>(null)
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<EmailDocumentsResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultRecipients = useMemo(() => {
    if (kind === 'CARRIER') {
      return [assignment?.dispatcherEmail].filter((e): e is string => !!e)
    }
    const contacts = (customer?.contacts ?? [])
      .filter((c) => c.active !== false && c.email)
      .filter((c) => c.types?.includes('BILLING') || c.types?.includes('OPERATIONS'))
      .map((c) => c.email as string)
    const fallback = [customer?.contactEmail, customer?.billingEmail].filter((e): e is string => !!e)
    return Array.from(new Set(contacts.length > 0 ? contacts : fallback))
  }, [kind, customer, assignment])

  const to = toOverride ?? defaultRecipients.join(', ')

  const rows = useMemo(
    () => documents.map((doc) => ({ doc, reason: refusal(doc, kind) })),
    [documents, kind],
  )
  const sendable = rows.filter((r) => r.reason === null)
  const chosen = sendable.filter((r) => selected.includes(r.doc.id)).map((r) => r.doc)

  const preview = renderDocumentsEmail({
    shipmentNumber: bundle.shipment.number,
    documents: chosen.map((d) => ({ name: d.name, type: d.type })),
    message: message.trim() || null,
    subject: subject.trim() || null,
    senderName,
    brokerName,
  })

  const send = async () => {
    const recipients = to.split(',').map((e) => e.trim()).filter(Boolean)
    if (recipients.length === 0) { setError('At least one recipient is required.'); return }
    if (chosen.length === 0) { setError('Choose at least one document.'); return }
    setBusy(true)
    setError(null)
    try {
      const answer = await emailDocuments({
        shipmentId: bundle.shipment.id,
        documentIds: chosen.map((d) => d.id),
        to: recipients,
        cc: cc.split(',').map((e) => e.trim()).filter(Boolean),
        subject: subject.trim() || null,
        message: message.trim() || null,
        recipientKind: kind,
      })
      setResult(answer)
      onSent()
      if (answer.emailStatus === 'SENT') toast.success(`Sent to ${recipients.join(', ')}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The documents could not be sent')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Send documents</DialogTitle></DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Send to</Label>
            <select
              aria-label="Recipient kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as RecipientKind)
                // The new recipient may not be allowed what the old one was.
                setSelected([])
                setToOverride(null)
              }}
              disabled={busy}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="CUSTOMER">Customer{customer?.name ? ` — ${customer.name}` : ''}</option>
              <option value="CARRIER">
                Carrier{assignment?.carrierName ? ` — ${assignment.carrierName}` : ''}
              </option>
            </select>
          </div>
          <div className="flex-1 min-w-56">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">To</Label>
            <Input
              aria-label="Recipients"
              value={to}
              onChange={(e) => setToOverride(e.target.value)}
              placeholder="nobody on file — type an address"
              className="h-9 text-sm"
            />
          </div>
          <div className="min-w-48">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">CC</Label>
            <Input aria-label="CC" value={cc} onChange={(e) => setCc(e.target.value)} className="h-9 text-sm" />
          </div>
        </div>

        <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-border p-2">
          {rows.length === 0 && <p className="text-sm text-muted-foreground">This shipment has no documents yet.</p>}
          {rows.map(({ doc, reason }) => (
            <label
              key={doc.id}
              className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-sm ${reason ? 'text-muted-foreground' : ''}`}
            >
              <input
                type="checkbox"
                aria-label={`Send ${doc.name}`}
                disabled={!!reason || busy}
                checked={selected.includes(doc.id)}
                onChange={(e) => setSelected((prev) => (
                  e.target.checked ? [...prev, doc.id] : prev.filter((id) => id !== doc.id)
                ))}
              />
              <Badge variant="outline" className="text-[10px]">{DOCUMENT_TYPE_LABELS[doc.type]}</Badge>
              <span className="min-w-0 flex-1 truncate">{doc.name}</span>
              <span className="text-[10px] uppercase tracking-wider">v{doc.version}</span>
              {reason && <span className="text-[11px] italic">{reason}</span>}
            </label>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Subject</Label>
            <Input
              aria-label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={preview.subject}
              className="h-9 text-sm"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Message</Label>
            <Textarea
              aria-label="Message"
              rows={2}
              placeholder="Leave blank for the standard covering note"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="text-sm"
            />
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Preview</p>
            <p className="mt-1 text-sm font-medium">{preview.subject}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm" data-testid="documents-email-preview">{preview.body}</p>
          </div>
        </div>

        {result && result.emailStatus !== 'SENT' && (
          <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-2 text-xs">
            <p className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
              {result.emailStatus === 'COPY'
                ? 'Nothing was e-mailed — the message and the links below are yours to send by hand.'
                : `The e-mail did not send${result.emailError ? `: ${result.emailError}` : ''}. The links below are live for an hour — send them by hand.`}
            </p>
            {result.downloads.map((d) => (
              <a
                key={d.documentId}
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate font-medium text-primary"
              >
                {d.name}
              </a>
            ))}
            <Button
              type="button" variant="outline" size="sm" className="mt-1"
              onClick={() => { void navigator.clipboard?.writeText(result.notice.body); toast.success('Message copied') }}
            >
              <Copy size={14} className="mr-1" />Copy the message
            </Button>
          </div>
        )}
        {result && result.emailStatus === 'SENT' && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Check size={14} className="text-emerald-600" />Sent to {result.notice.to}
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
          <Button
            variant="outline"
            onClick={() => { void navigator.clipboard?.writeText(preview.body); toast.success('Message copied') }}
            disabled={busy}
          >
            <Copy size={14} className="mr-1" />Copy
          </Button>
          <Button onClick={() => { void send() }} disabled={busy || chosen.length === 0}>
            {busy ? <Mail size={14} className="mr-1" /> : <Send size={14} className="mr-1" />}
            {busy ? 'Sending…' : `Send ${chosen.length || ''}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
