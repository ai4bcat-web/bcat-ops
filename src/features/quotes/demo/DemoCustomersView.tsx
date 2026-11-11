/**
 * The "Customers" demo surface of the Quotes page: who has asked us for quotes, how many we
 * won, and the conversation behind each one. Entirely fabricated seed data (demoQuotes.ts),
 * never read from or written to an API, and never mixed into the real quotes list.
 */
import { useState } from 'react'
import { TmsButton, TmsPage, TmsTable } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { formatCents } from '@/lib/invoiceBuild'
import { allCustomerStats } from '../demoQuotes'
import type { CustomerStats, DemoCustomer, DemoQuote } from '../demoQuotes'
import { CustomerPanel } from './CustomerPanel'
import { QuoteConversationDrawer } from './QuoteConversationDrawer'
import { demoDay } from './demoFormat'
import { DemoBadge, WinBar } from './DemoBits'

const COLUMNS: Array<ColumnDef<CustomerStats>> = [
  {
    key: 'customer', header: 'Customer', width: 260,
    render: (s) => (<><div className="tms-qd-name">{s.customer.name}</div><div className="tms-qd-sub">{s.customer.kind} · {s.customer.contact}</div></>),
  },
  { key: 'received', header: 'Quotes received', width: 110, render: (s) => <span className="tms-qd-num">{s.received}</span> },
  { key: 'won', header: 'Quotes won', width: 100, render: (s) => <span className="tms-qd-num">{s.won}</span> },
  { key: 'rate', header: 'Win rate', width: 170, render: (s) => <WinBar rate={s.winRate} /> },
  { key: 'quoted', header: 'Total quoted', width: 120, render: (s) => <span className="tms-qd-num">{formatCents(s.quotedCents)}</span> },
  { key: 'wonamt', header: 'Won $', width: 120, render: (s) => <span className="tms-qd-num">{formatCents(s.wonCents)}</span> },
  { key: 'last', header: 'Last quote', width: 120, render: (s) => demoDay(s.lastQuoteDate) },
]

export function DemoCustomersView({ onBack }: { onBack: () => void }) {
  const [customer, setCustomer] = useState<DemoCustomer | null>(null)
  const [quote, setQuote] = useState<DemoQuote | null>(null)
  const stats = allCustomerStats()

  return (
    <TmsPage
      title={<span className="tms-qd-titlerow">Quote · Customers<DemoBadge /></span>}
      actions={<TmsButton onClick={onBack}>Back to spot quotes</TmsButton>}
    >
      <p className="tms-qd-intro">
        Demo only: every customer, quote and e-mail below is made up to show how quote history and
        negotiation threads will look. Nothing here comes from real quotes.
      </p>
      <div className="tms-qd-card">
        <TmsTable
          columns={COLUMNS}
          rows={stats}
          rowKey={(s) => s.customer.id}
          onRowClick={(s) => setCustomer(s.customer)}
          empty="No customers."
        />
      </div>
      <CustomerPanel customer={customer} onClose={() => { setQuote(null); setCustomer(null) }} onOpenQuote={setQuote} quoteOpen={quote !== null} />
      <QuoteConversationDrawer quote={quote} onClose={() => setQuote(null)} />
    </TmsPage>
  )
}
