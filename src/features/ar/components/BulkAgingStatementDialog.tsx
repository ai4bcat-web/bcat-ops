/**
 * Email aging reports to several customers: previews every statement first (recipient, open
 * invoices, total), then sends only the ones that can go. Each customer gets their own statement.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { agingStatement, graphqlErrorText, type AgingStatementResult } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { statementBlocker } from '../statementBlocker'

export interface BulkStatementCustomer { id: string; name: string }

type Row = { customer: BulkStatementCustomer; preview: AgingStatementResult | null; error: string | null; sent?: string }

export function BulkAgingStatementDialog({ customers, onClose, onDone }: {
  customers: BulkStatementCustomer[]
  onClose: () => void
  onDone: () => void
}) {
  const [rows, setRows] = useState<Row[]>(() => customers.map((customer) => ({ customer, preview: null, error: null })))
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      for (const customer of customers) {
        let preview: AgingStatementResult | null = null
        let error: string | null = null
        try { preview = await agingStatement({ customerId: customer.id }) } catch (err) { error = graphqlErrorText(err) }
        if (!alive) return
        setRows((prev) => prev.map((r) => (r.customer.id === customer.id ? { ...r, preview, error } : r)))
      }
      if (alive) setLoading(false)
    })()
    return () => { alive = false }
  }, [customers])

  const ready = rows.filter((r) => r.preview && !statementBlocker(r.preview, r.error) && !r.sent)
  const totalCents = ready.reduce((sum, r) => sum + (r.preview?.statement.totalCents ?? 0), 0)

  const send = async () => {
    setSending(true)
    let sent = 0
    for (const row of ready) {
      let outcome: string
      try {
        const res = await agingStatement({ customerId: row.customer.id, send: true })
        if (res.emailStatus === 'SENT') { sent++; outcome = 'Sent' } else outcome = `Not sent: ${res.emailError || res.emailStatus}`
      } catch (err) {
        outcome = `Not sent: ${graphqlErrorText(err)}`
      }
      setRows((prev) => prev.map((r) => (r.customer.id === row.customer.id ? { ...r, sent: outcome } : r)))
    }
    setSending(false)
    if (sent) toast.success(`Sent ${sent} aging report${sent === 1 ? '' : 's'}`)
    if (sent === ready.length) { onDone() }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(open) => { if (!open && !sending) { onClose() } }}
      title={`Email aging reports — ${customers.length} customer${customers.length === 1 ? '' : 's'}`}
      className="tms-dialog-wide"
      footer={
        <>
          <TmsButton variant="ghost" onClick={onClose} disabled={sending}>Close</TmsButton>
          <TmsButton variant="primary" onClick={() => void send()} disabled={loading || sending || ready.length === 0} data-testid="bulk-statement-send">
            {sending ? 'Sending…' : `Send ${ready.length} · ${formatCents(totalCents)}`}
          </TmsButton>
        </>
      }
    >
      <p className="text-sm tms-muted">
        Each customer gets their own statement at their invoice e-mail, with billing@bcatcorp.com copied. Factored invoices are left off.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="tms-table text-sm" data-testid="bulk-statement-table">
          <thead><tr><th>Customer</th><th>To</th><th className="text-right">Open</th><th className="text-right">Total</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const blocker = statementBlocker(r.preview, r.error)
              return (
                <tr key={r.customer.id}>
                  <td>{r.customer.name}</td>
                  <td>{r.preview ? r.preview.to.join(', ') || '—' : ''}</td>
                  <td className="text-right">{r.preview ? r.preview.statement.rows : ''}</td>
                  <td className="text-right">{r.preview ? formatCents(r.preview.statement.totalCents) : ''}</td>
                  <td>
                    {r.sent ?? (!r.preview && !r.error
                      ? <span className="inline-flex items-center gap-1 tms-muted"><Loader2 size={12} className="animate-spin" /> Building…</span>
                      : blocker
                        ? <span style={{ color: 'var(--tms-badge-red)' }}>{blocker}</span>
                        : 'Ready')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </TmsDialog>
  )
}
