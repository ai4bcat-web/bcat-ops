/** One DEMO customer: the roll-up numbers, then every quote they sent us. All fabricated. */
import { TmsDrawer, TmsStatRow, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { customerStats, quotesForCustomer } from '../demoQuotes'
import type { CustomerStats, DemoCustomer, DemoQuote } from '../demoQuotes'
import { demoDay } from './demoFormat'
import { DemoBadge, DemoOutcomeChip, WinBar } from './DemoBits'

const COLUMNS: Array<ColumnDef<DemoQuote>> = [
  { key: 'date', header: 'Date', width: 110, render: (q) => demoDay(q.date) },
  {
    key: 'lane', header: 'Lane', width: 230,
    render: (q) => (<><div className="tms-qd-name">{q.origin} → {q.destination}</div><div className="tms-qd-sub">{q.id}</div></>),
  },
  { key: 'equip', header: 'Equipment', width: 100, render: (q) => q.equipment },
  { key: 'rate', header: 'Our rate', width: 100, render: (q) => <span className="tms-qd-num">{formatCents(q.quotedCents)}</span> },
  { key: 'outcome', header: 'Outcome', width: 100, render: (q) => <DemoOutcomeChip outcome={q.outcome} /> },
  {
    key: 'comp', header: 'Competing price', width: 120,
    render: (q) => (q.outcome === 'lost' && q.competitorCents !== null
      ? <span className="tms-qd-num">{formatCents(q.competitorCents)}</span>
      : <span className="tms-muted">—</span>),
  },
]

function customerStatItems(s: CustomerStats) {
  return [
    { key: 'received', label: 'Quotes received', value: String(s.received) },
    { key: 'won', label: 'Quotes won', value: String(s.won), tone: 'good' as const },
    { key: 'rate', label: 'Win rate', value: `${Math.round(s.winRate * 100)}%` },
    { key: 'quoted', label: 'Total quoted', value: formatCents(s.quotedCents) },
    { key: 'wonamt', label: 'Won', value: formatCents(s.wonCents), tone: 'good' as const },
  ]
}

export function CustomerPanel({ customer, onClose, onOpenQuote, quoteOpen }: {
  customer: DemoCustomer | null
  onClose: () => void
  onOpenQuote: (q: DemoQuote) => void
  quoteOpen: boolean
}) {
  if (!customer) return null
  const stats = customerStats(customer)
  const quotes = quotesForCustomer(customer.id)
  return (
    <TmsDrawer
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      size="xl"
      onInteractOutside={quoteOpen ? (e) => e.preventDefault() : undefined}
      title={<span className="tms-qd-titlerow">{customer.name}<DemoBadge /></span>}
      description={`${customer.kind} · ${customer.contact} · ${customer.email}`}
    >
      <div className="tms-qd-panel" data-testid="customer-panel">
        <TmsStatRow items={customerStatItems(stats)} columns={5} compact aria-label="Customer quote totals" />
        <div className="tms-qd-rate-cell" aria-label="Win rate bar"><WinBar rate={stats.winRate} /></div>
        <div className="tms-qd-card">
          <TmsTable
            columns={COLUMNS}
            rows={quotes}
            rowKey={(q) => q.id}
            onRowClick={onOpenQuote}
            empty="No quotes."
          />
        </div>
        <p className="tms-qd-sub">Select a quote to read the e-mail conversation. Fabricated demo data.</p>
      </div>
    </TmsDrawer>
  )
}
