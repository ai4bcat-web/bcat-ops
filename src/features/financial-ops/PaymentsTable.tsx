/**
 * The "Payment transactions" card: AR receipts and AP payments in the window, newest first.
 * Presentation only — rows, statuses and the CSV text arrive from `lib/financeOps`. The
 * download icon appears only on AP rows that have a stored remittance advice (AR has no
 * document).
 */
import { useState } from 'react'
import { Download } from 'lucide-react'
import {
  TmsAlert, TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsIconButton, TmsTable,
  type ColumnDef, type TmsTone,
} from '@/features/tms/kit'
import { getRemittancePdfUrl } from '@/lib/apiClient'
import { chicagoDateStr } from '@/lib/date'
import { downloadFromUrl, saveBlob } from '@/lib/download'
import { PAYMENT_STATUS_LABEL, paymentsCsv, type PaymentRow, type PaymentStatus } from '@/lib/financeOps'
import { formatCents } from '@/lib/invoiceBuild'

const STATUS_TONE: Record<PaymentStatus, TmsTone> = {
  APPLIED: 'green',
  PARTIAL: 'orange',
  UNAPPLIED: 'blue',
  REMITTED: 'green',
  RECORDED: 'gray',
  REVERSED: 'red',
}

const RIGHT = { display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const

export function PaymentsTable({ rows, windowLabel }: { rows: PaymentRow[]; windowLabel: string }) {
  const [error, setError] = useState<string | null>(null)

  const downloadAdvice = (row: PaymentRow) => {
    if (!row.pdfKey) return
    setError(null)
    getRemittancePdfUrl(row.pdfKey)
      .then((url) => downloadFromUrl(url, `remittance-${row.id}.pdf`))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The remittance advice could not be downloaded'))
  }

  const columns: ColumnDef<PaymentRow>[] = [
    { key: 'date', header: 'DATE', render: (r) => chicagoDateStr(r.at) },
    {
      key: 'type',
      header: 'TYPE',
      render: (r) => <TmsBadge tone={r.type === 'AR' ? 'blue' : 'purple'}>{r.type === 'AR' ? 'AR receipt' : 'AP payment'}</TmsBadge>,
    },
    { key: 'counterparty', header: 'COUNTERPARTY', render: (r) => r.counterparty },
    {
      key: 'reference',
      header: 'REFERENCE · METHOD',
      render: (r) => [r.reference, r.method].filter(Boolean).join(' · ') || '—',
    },
    {
      key: 'amount',
      header: 'AMOUNT',
      render: (r) => (
        <span
          style={{ ...RIGHT, color: r.amountCents >= 0 ? 'var(--tms-badge-green)' : 'var(--tms-badge-red)' }}
        >
          {r.amountCents >= 0 ? '+' : '−'}{formatCents(Math.abs(r.amountCents))}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'STATUS',
      render: (r) => <TmsBadge tone={STATUS_TONE[r.status]}>{PAYMENT_STATUS_LABEL[r.status]}</TmsBadge>,
    },
    {
      key: 'advice',
      header: '',
      width: 48,
      render: (r) =>
        r.pdfKey ? (
          <TmsIconButton shape="plain" aria-label={`Download remittance advice for ${r.counterparty}`} onClick={() => downloadAdvice(r)}>
            <Download size={14} />
          </TmsIconButton>
        ) : null,
    },
  ]

  return (
    <TmsCard
      title="Payment transactions"
      flush
      actions={
        <TmsButton
          size="sm"
          disabled={rows.length === 0}
          onClick={() => saveBlob(new Blob([paymentsCsv(rows)], { type: 'text/csv' }), `payments-${windowLabel}.csv`)}
        >
          <Download size={14} /> Download
        </TmsButton>
      }
    >
      {error ? <TmsAlert tone="red">{error}</TmsAlert> : null}
      <TmsTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.type}:${r.id}`}
        empty={<TmsEmptyState compact title="No payments in this window." message="AR receipts and AP payments recorded in the period appear here." />}
      />
    </TmsCard>
  )
}
