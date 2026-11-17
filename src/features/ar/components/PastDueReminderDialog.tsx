/**
 * Past-due reminder: previews the e-mail that asks a customer when it will pay the invoices below,
 * with the To and CC editable, and sends it only when Send is pressed. One card per customer;
 * invoices for the same customer always travel in one e-mail. Built from PAST_DUE_REMINDER's
 * preview, so the dialog never guesses at recipients or wording.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog, TmsInput } from '@/features/tms/kit'
import { graphqlErrorText, pastDueReminder, type PastDueReminderResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'

export interface PastDueGroup { customerId: string; customerName: string; invoiceIds: string[] }

interface Card {
  group: PastDueGroup
  preview: PastDueReminderResult | null
  error: string | null
  to: string
  cc: string
  confirmRecent: boolean
  sent: boolean
}

const split = (text: string): string[] => text.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean)
const day = (iso: string) => iso.slice(0, 10)

export function PastDueReminderDialog({ groups, onClose, onSent }: {
  groups: PastDueGroup[]
  onClose: () => void
  onSent: () => void
}) {
  const [cards, setCards] = useState<Card[]>(() => groups.map((group) => ({ group, preview: null, error: null, to: '', cc: '', confirmRecent: false, sent: false })))
  const [sending, setSending] = useState(false)
  const [sentAny, setSentAny] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      for (const group of groups) {
        let preview: PastDueReminderResult | null = null
        let error: string | null = null
        try { preview = await pastDueReminder({ invoiceIds: group.invoiceIds }) } catch (err) { error = graphqlErrorText(err) }
        if (!alive) return
        setCards((prev) => prev.map((c) => (c.group.customerId === group.customerId
          ? { ...c, preview, error, to: preview?.to.join(', ') ?? '', cc: preview?.cc.join(', ') ?? '' }
          : c)))
      }
    })()
    return () => { alive = false }
  }, [groups])

  const patch = (customerId: string, change: Partial<Card>) =>
    setCards((prev) => prev.map((c) => (c.group.customerId === customerId ? { ...c, ...change } : c)))

  const blocker = (c: Card): string | null => {
    if (c.sent) return null
    if (!c.preview) return c.error ?? 'Building the reminder…'
    if (split(c.to).length === 0) return 'Add an e-mail address to send to'
    if ((c.preview.recent?.length ?? 0) > 0 && !c.confirmRecent) return 'A reminder went out recently: tick the box to send another'
    return null
  }
  const ready = cards.filter((c) => !c.sent && c.preview && !blocker(c))

  const send = async () => {
    setSending(true)
    let sent = 0
    for (const c of ready) {
      try {
        const res = await pastDueReminder({ invoiceIds: c.group.invoiceIds, send: true, to: split(c.to), cc: split(c.cc), confirmRecent: c.confirmRecent })
        if (res.emailStatus === 'SENT') {
          sent += 1
          patch(c.group.customerId, { sent: true, error: null })
        } else {
          patch(c.group.customerId, { error: res.emailError || `Not sent (${res.emailStatus ?? 'unknown'})` })
        }
      } catch (err) {
        patch(c.group.customerId, { error: graphqlErrorText(err) })
      }
    }
    setSending(false)
    if (sent > 0) {
      setSentAny(true)
      toast.success(`Past due reminder sent to ${sent} customer${sent === 1 ? '' : 's'}`)
    }
  }

  const close = () => { if (sentAny) onSent(); else onClose() }
  const loading = cards.some((c) => !c.preview && !c.error)
  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !sending) close() }}
      title={cards.length === 1 ? `Past due reminder — ${cards[0].group.customerName}` : `Past due reminders — ${cards.length} customers`}
      className="tms-dialog-wide"
      footer={(
        <>
          <TmsButton variant="ghost" onClick={close} disabled={sending}>{sentAny ? 'Done' : 'Cancel'}</TmsButton>
          <TmsButton variant="primary" onClick={() => void send()} disabled={sending || ready.length === 0} data-testid="past-due-send">
            {sending ? 'Sending…' : ready.length > 1 ? `Send ${ready.length} reminders` : 'Send'}
          </TmsButton>
        </>
      )}
    >
      <p className="text-xs tms-muted">Nothing goes out until you press Send. The customer gets the table below; no documents are attached.</p>
      {loading && <p className="flex items-center gap-2 tms-muted"><Loader2 size={14} className="animate-spin" /> Building the reminder…</p>}
      <div className="grid gap-4">
        {cards.map((c) => (
          <section key={c.group.customerId} className="grid gap-2" data-testid="past-due-card" aria-label={`Reminder for ${c.group.customerName}`}>
            {cards.length > 1 && <strong>{c.group.customerName}</strong>}
            {c.sent && <p className="text-sm" style={{ color: 'var(--tms-badge-green)' }}>Sent to {c.to}</p>}
            {c.preview && !c.sent && (
              <>
                <dl className="grid gap-2 text-sm" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                  <dt className="tms-muted"><label htmlFor={`pdr-to-${c.group.customerId}`}>To</label></dt>
                  <dd>
                    <TmsInput id={`pdr-to-${c.group.customerId}`} aria-label={`To for ${c.group.customerName}`} value={c.to} placeholder="billing@customer.com"
                      onChange={(e) => patch(c.group.customerId, { to: e.target.value })} />
                    {split(c.to).length === 0 && (
                      <span className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>No invoice e-mail on file for this customer. Type one to send, and add it on the customer to keep it.</span>
                    )}
                  </dd>
                  <dt className="tms-muted"><label htmlFor={`pdr-cc-${c.group.customerId}`}>CC</label></dt>
                  <dd><TmsInput id={`pdr-cc-${c.group.customerId}`} aria-label={`CC for ${c.group.customerName}`} value={c.cc} onChange={(e) => patch(c.group.customerId, { cc: e.target.value })} /></dd>
                  <dt className="tms-muted">Subject</dt>
                  <dd>{c.preview.subject}</dd>
                  <dt className="tms-muted">Message</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{c.preview.body.split('\n')[0]}</dd>
                </dl>
                <div style={{ overflowX: 'auto' }}>
                  <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="tms-muted" style={{ textAlign: 'left' }}>
                        <th>Invoice #</th><th>PRO</th><th>PO / Ref</th><th>Invoice date</th><th>Due</th>
                        <th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Balance</th><th style={{ textAlign: 'right' }}>Days past due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(c.preview.rows ?? []).map((r) => (
                        <tr key={r.invoiceId}>
                          <td>{r.invoiceNumber}</td><td>{r.pro}</td><td>{r.po ?? ''}</td><td>{day(r.invoiceDate)}</td><td>{day(r.dueAt)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCents(r.totalCents)}</td>
                          <td style={{ textAlign: 'right' }}>{formatCents(r.balanceCents)}</td>
                          <td style={{ textAlign: 'right' }}>{r.daysPastDue}</td>
                        </tr>
                      ))}
                      <tr><td colSpan={6}><strong>Total past due</strong></td><td style={{ textAlign: 'right' }}><strong>{formatCents(c.preview.summary.totalCents)}</strong></td><td /></tr>
                    </tbody>
                  </table>
                </div>
                {(c.preview.recent?.length ?? 0) > 0 && (
                  <label className="flex items-center gap-2 text-sm" data-testid="past-due-recent">
                    <input type="checkbox" checked={c.confirmRecent} onChange={(e) => patch(c.group.customerId, { confirmRecent: e.target.checked })} />
                    <span>
                      A reminder already went out{' '}
                      {c.preview.recent?.map((r) => `${r.invoiceNumber} on ${day(r.sentAt)}`).join(', ')}. Send another anyway.
                    </span>
                  </label>
                )}
              </>
            )}
            {c.error && <p className="text-xs" style={{ color: 'var(--tms-badge-red)' }}>{c.error}</p>}
          </section>
        ))}
      </div>
    </TmsDialog>
  )
}
