/**
 * The Quote page: one page, two URL-backed tabs. Quote inbox (the Spot inbox, `/tms/rates/spot`) comes
 * first and is where the lifecycle strip lands; Quotes (`/tms/rates`) is second. Each tab reuses its
 * existing page body unchanged; this wrapper only draws the tab strip above it.
 */
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TmsTabs } from '@/features/tms/kit'
import { QuotesPage } from './QuotesPage'
import { SpotInboxPage } from '@/features/spot-quoter/SpotInboxPage'
import { useSpotNewCount } from '@/features/spot-quoter/useSpotRequests'
import { DemoToggle, QuoteDemoPanel } from './demo/QuoteDemoPanel'
import { useQuoteDemo } from './demo/useQuoteDemo'

type QuoteTabKey = 'inbox' | 'quotes'

const QUOTE_PAGE_TABS: ReadonlyArray<{ key: QuoteTabKey; label: string; to: string }> = [
  { key: 'inbox', label: 'Quote inbox', to: '/tms/rates/spot' },
  { key: 'quotes', label: 'Quotes', to: '/tms/rates' },
]

export function QuotePage({ tab }: { tab: QuoteTabKey }) {
  const navigate = useNavigate()
  const inboxCount = useSpotNewCount(true)
  // Each tab reports how many REAL rows it has (null while it is still loading): demo data shows by default only when that is zero.
  const [real, setReal] = useState<Record<QuoteTabKey, number | null>>({ inbox: null, quotes: null })
  const reportInbox = useCallback((n: number | null) => setReal((p) => (p.inbox === n ? p : { ...p, inbox: n })), [])
  const reportQuotes = useCallback((n: number | null) => setReal((p) => (p.quotes === n ? p : { ...p, quotes: n })), [])
  const demo = useQuoteDemo(real[tab])
  return (
    <div className="tms-page">
      <TmsTabs
        tabs={QUOTE_PAGE_TABS.map((t) => ({
          key: t.key,
          label: t.label,
          count: t.key === 'inbox' && inboxCount > 0 ? inboxCount : undefined,
        }))}
        active={tab}
        onSelect={(key) => navigate(QUOTE_PAGE_TABS.find((t) => t.key === key)?.to ?? '/tms/rates')}
      />
      <div className="tms-qd-togglebar"><DemoToggle on={demo.on} onChange={demo.setOn} /></div>
      {tab === 'inbox' ? <SpotInboxPage onRealCount={reportInbox} /> : <QuotesPage onRealCount={reportQuotes} />}
      {demo.on ? <QuoteDemoPanel tab={tab} /> : null}
    </div>
  )
}

export default QuotePage
