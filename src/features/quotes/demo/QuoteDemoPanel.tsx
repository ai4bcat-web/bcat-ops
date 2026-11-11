/**
 * The demo data on the Quote tab: fabricated spot-quote requests / customer quotes (demoQuotes.ts) drawn BELOW whatever real rows the
 * page has. Read-only: rows open the made-up e-mail negotiator thread, every action is disabled with the title "Demo data", and nothing
 * here calls an API. Relative imports only for the demo data.
 */
import { useMemo, useState } from 'react'
import { TmsButton, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { demoCustomer } from '../demoQuotes'
import type { DemoQuote } from '../demoQuotes'
import { DemoCustomersView } from './DemoCustomersView'
import { QuoteConversationDrawer } from './QuoteConversationDrawer'
import { DemoBadge, DemoOutcomeChip } from './DemoBits'
import { demoDay } from './demoFormat'
import { DEMO_TITLE, demoRows, demoTotals } from './quoteDemoModel'

export function DemoToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="tms-qd-toggle" data-testid="quote-demo-toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> Show demo data
    </label>
  )
}

export function QuoteDemoPanel({ tab }: { tab: 'inbox' | 'quotes' }) {
  const [quote, setQuote] = useState<DemoQuote | null>(null)
  const [customers, setCustomers] = useState(false)
  const rows = useMemo(() => demoRows(), [])
  const totals = demoTotals()

  const columns: Array<ColumnDef<DemoQuote>> = [
    { key: 'date', header: tab === 'inbox' ? 'Received' : 'Date', width: 120, render: (q) => demoDay(q.date) },
    { key: 'customer', header: 'Customer', width: 220, render: (q) => demoCustomer(q.customerId)?.name ?? q.customerId },
    { key: 'lane', header: 'Lane', width: 260, render: (q) => `${q.origin} → ${q.destination}` },
    { key: 'equip', header: 'Equipment', width: 100, render: (q) => q.equipment },
    { key: 'miles', header: 'Miles', width: 70, render: (q) => <span className="tms-qd-num">{q.miles}</span> },
    { key: 'quoted', header: 'Quoted', width: 100, render: (q) => <span className="tms-qd-num">{formatCents(q.quotedCents)}</span> },
    { key: 'status', header: 'Status', width: 100, render: (q) => <DemoOutcomeChip outcome={q.outcome} /> },
    { key: 'demo', header: '', width: 110, render: () => <DemoBadge /> },
    {
      key: 'actions', header: '', width: 90,
      render: () => <TmsButton size="sm" disabled title={DEMO_TITLE} data-testid="demo-action">{tab === 'inbox' ? 'Respond' : 'Quote'}</TmsButton>,
    },
  ]

  if (customers) return <DemoCustomersView onBack={() => setCustomers(false)} />

  return (
    <section className="tms-qd-panel" data-testid="quote-demo-panel" aria-label="Demo data">
      <div className="tms-qd-banner" role="note">
        <DemoBadge />
        <span>
          Everything below is made-up demo data: customers, lanes, rates and e-mail negotiator conversations. It is not saved anywhere and none of it is real.
          Click a row to read the conversation.
        </span>
        <TmsButton size="sm" onClick={() => setCustomers(true)}>Customers</TmsButton>
      </div>
      <dl className="tms-qd-totals" data-testid="demo-totals">
        <div><dt>{tab === 'inbox' ? 'Requests received' : 'Quotes sent'}</dt><dd>{totals.received}</dd></div>
        <div><dt>Won</dt><dd>{totals.won}</dd></div>
        <div><dt>Win rate</dt><dd>{Math.round(totals.winRate * 100)}%</dd></div>
        <div><dt>Won $</dt><dd>{formatCents(totals.wonCents)}</dd></div>
        <div><dt>Waiting</dt><dd>{totals.open}</dd></div>
      </dl>
      <div className="tms-qd-card">
        <TmsTable columns={columns} rows={rows} rowKey={(q) => q.id} onRowClick={setQuote} empty="No demo rows." />
      </div>
      <QuoteConversationDrawer quote={quote} onClose={() => setQuote(null)} />
    </section>
  )
}
