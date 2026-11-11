/**
 * The e-mail negotiator thread for one DEMO quote: message cards in order, the rate
 * highlighted wherever a message states one, and a footer summary. All fabricated.
 */
import { TmsDrawer } from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/invoiceBuild'
import { DEMO_TARGET_MARGIN_PCT, quoteSummary, threadFor } from '../demoQuotes'
import type { DemoQuote } from '../demoQuotes'
import { DEMO_OUTCOME_LABEL, demoDay } from './demoFormat'
import { DemoBadge, DemoOutcomeChip } from './DemoBits'

const ROLE_LABEL = { customer: 'Customer', agent: 'AI quoting agent', sales: 'BCAT sales' } as const

export function QuoteConversationDrawer({ quote, onClose }: { quote: DemoQuote | null; onClose: () => void }) {
  if (!quote) return null
  const thread = threadFor(quote)
  const summary = quoteSummary(quote)
  const lane = `${quote.origin} → ${quote.destination}`
  const rateless = quote.outcome === 'lost' || quote.outcome === 'expired'
  return (
    <TmsDrawer
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      size="xl"
      zIndex={1300}
      title={<span className="tms-qd-titlerow">{lane}<DemoBadge /></span>}
      description={`${quote.id} · ${quote.equipment} · ${quote.miles} mi · ${demoDay(quote.date)}`}
      headerExtra={<DemoOutcomeChip outcome={quote.outcome} />}
      footer={(
        <dl className="tms-qd-summary" data-testid="thread-summary">
          <div><dt>{quote.outcome === 'won' ? 'Final rate' : 'Last quoted'}</dt><dd>{formatCents(summary.finalCents)}</dd></div>
          <div><dt>Outcome</dt><dd>{DEMO_OUTCOME_LABEL[quote.outcome]}</dd></div>
          <div><dt>Time to quote</dt><dd>{summary.minutesToQuote} min</dd></div>
          <div>
            <dt>Margin vs {DEMO_TARGET_MARGIN_PCT}% target</dt>
            <dd className={summary.vsTargetPts >= 0 ? 'tms-qd-good' : 'tms-qd-bad'}>
              {summary.marginPct.toFixed(1)}% ({summary.vsTargetPts >= 0 ? '+' : ''}{summary.vsTargetPts.toFixed(1)} pts)
            </dd>
          </div>
          {rateless && quote.competitorCents !== null ? (
            <div><dt>Competing price</dt><dd>{formatCents(quote.competitorCents)}</dd></div>
          ) : null}
        </dl>
      )}
    >
      <p className="tms-qd-intro">Fabricated demo conversation. No e-mail was sent or received.</p>
      <div className="tms-qd-thread" data-testid="thread">
        {thread.map((m) => (
          <article key={m.id} className={`tms-qd-msg tms-qd-msg-${m.role}`} data-testid="thread-message">
            <header className="tms-qd-msg-head">
              <span><span className="tms-qd-from">{m.from}</span> · {ROLE_LABEL[m.role]}</span>
              <time dateTime={m.at}>{formatDateTime(m.at)}</time>
            </header>
            {m.subject ? <div className="tms-qd-subject">{m.subject}</div> : null}
            <p className="tms-qd-body">{m.body}</p>
            {m.rateCents !== undefined ? <span className="tms-qd-rate" data-testid="thread-rate">{formatCents(m.rateCents)}</span> : null}
          </article>
        ))}
      </div>
    </TmsDrawer>
  )
}
