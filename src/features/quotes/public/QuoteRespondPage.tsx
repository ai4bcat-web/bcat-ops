import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, Clock, Send, XCircle } from 'lucide-react'
import {
  fetchQuoteLink, quoteLinkAvailable, respondToQuote, QuoteLinkError,
  type QuotePublicView,
} from '@/lib/quoteLinkClient'
import { PUBLIC_DECLINE_REASONS } from '@/lib/quotes'
import type { QuoteLostReason } from '@/types/tms'
import { TmsAlert, TmsButton, TmsCard, TmsInput, TmsMetaList, TmsPublicFrame, TmsSelect, TmsTextarea } from '@/features/tms/kit'

// This page is PUBLIC — a customer or a carrier opens it from an emailed link with no
// account. It must never import anything that needs Cognito (no useAuth, no apiClient);
// the only backend it talks to is the tracking API's /q/<token> routes via
// quoteLinkClient. It renders only what `QuotePublicView` carries: the view is built by
// an allow-list server-side, and nothing here may reach for a field beside it.

const DECLINE_LABELS: Record<QuoteLostReason, string> = {
  EXPIRED: 'It expired',
  NO_RESPONSE: 'No response',
  TOO_HIGH: 'The price is too high',
  TOO_SLOW: 'We needed an answer sooner',
  TRUCK_NOT_AVAILABLE: 'No truck available',
  WITHDRAWN: 'We are withdrawing',
  OTHER: 'Something else',
  NO_REASON: 'I would rather not say',
}

/** `$1,234.56` — the page prints money and never does arithmetic on it. */
function money(cents: number): string {
  const negative = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const dollars = Math.floor(abs / 100)
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${String(abs - dollars * 100).padStart(2, '0')}`
}

function whenText(iso: string | null | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

/** `2 days`, `6 hours`, `25 minutes` — how long they have left to answer. */
function countdownText(expiresAt: string | null | undefined, from: number): string | null {
  if (!expiresAt) return null
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return null
  const left = at - from
  if (left <= 0) return null
  const minutes = Math.round(left / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

type Choice = 'ACCEPT' | 'COUNTER' | 'DECLINE' | 'QUOTE' | 'PASS'

export function QuoteRespondPage() {
  const { token = '' } = useParams()
  const [view, setView] = useState<QuotePublicView | null>(null)
  const [loadError, setLoadError] = useState<QuoteLinkError | null>(null)
  const [loading, setLoading] = useState(() => quoteLinkAvailable() && token !== '')
  const [loadedAt, setLoadedAt] = useState<number | null>(null)

  const [choice, setChoice] = useState<Choice | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState<QuoteLostReason>('TOO_HIGH')
  const [message, setMessage] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<Choice | null>(null)

  // The SPA's index.html title is "BCAT OPS" (internal app) — override for the guest.
  useEffect(() => {
    document.title = 'Quote'
    return () => { document.title = 'BCAT OPS' }
  }, [])

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!quoteLinkAvailable() || token === '') return
    fetchQuoteLink(token)
      .then((next) => {
        setView(next)
        setLoadedAt(Date.now())
        setLoadError(null)
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof QuoteLinkError ? err : new QuoteLinkError(0, 'Could not load this quote'))
      })
      .finally(() => setLoading(false))
  }, [token])

  // `loadedAt` is stamped in the same promise chain that set `view`, so the countdown
  // is measured from when the link was read rather than from a clock read during render.
  const countdown = useMemo(
    () => (loadedAt === null ? null : countdownText(view?.expiresAt, loadedAt)),
    [view, loadedAt],
  )

  if (!quoteLinkAvailable()) {
    return (
      <Shell>
        <Notice tone="warn" title="This quote link cannot be opened">
          The service behind it is not configured. Contact your representative and they will send the
          quote another way.
        </Notice>
      </Shell>
    )
  }

  if (loading) {
    return <Shell><div className="tms-public-loading">Loading…</div></Shell>
  }

  // ── 410: somebody already answered this round ──
  if (loadError?.status === 410) {
    return (
      <Shell>
        <Notice tone="good" title="This quote has already been answered">
          Your answer is with us — there is nothing more to do here. If that was not you, or you have
          changed your mind, reply to the e-mail this link came in and we will send a fresh quote.
        </Notice>
      </Shell>
    )
  }

  // ── 404 and everything else that leaves nothing to answer ──
  if (loadError || !view) {
    return (
      <Shell>
        <Notice tone="warn" title={loadError?.message ?? 'This quote link is no longer active'}>
          Links expire once the quote does, and each one can be answered once. Ask your representative
          for a new one.
        </Notice>
      </Shell>
    )
  }

  if (done) {
    const spoken: Record<Choice, string> = {
      ACCEPT: 'Accepted — thank you.',
      COUNTER: 'Your number is with us.',
      DECLINE: 'Thanks for letting us know.',
      QUOTE: 'Your rate is with us.',
      PASS: 'Thanks for letting us know.',
    }
    return (
      <Shell broker={view.brokerName}>
        <Notice tone={done === 'DECLINE' || done === 'PASS' ? 'warn' : 'good'} title={spoken[done]}>
          {view.brokerName} has your answer on quote {view.quoteNumber}. Somebody will be in touch.
          You can close this page.
        </Notice>
      </Shell>
    )
  }

  if (view.expired) {
    return (
      <Shell broker={view.brokerName}>
        <Notice tone="warn" title={`Quote ${view.quoteNumber} has expired`}>
          This price was good until {whenText(view.expiresAt)}. Ask {view.brokerName} for a fresh quote
          and we will re-price the lane.
        </Notice>
      </Shell>
    )
  }

  if (view.awaiting !== 'YOU') {
    return (
      <Shell broker={view.brokerName}>
        <Notice tone="good" title={`Quote ${view.quoteNumber} is with us`}>
          Nothing is waiting on you — {view.brokerName} is working on it and will come back to you.
        </Notice>
      </Shell>
    )
  }

  const sell = view.side === 'SELL'
  const amountCents = (() => {
    const parsed = Number(amount.replace(/[^0-9.]/g, ''))
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null
  })()
  const needsAmount = choice === 'COUNTER' || choice === 'QUOTE'
  const canSubmit =
    !busy && choice !== null && name.trim() !== '' && email.trim().includes('@')
    && (!needsAmount || amountCents !== null)

  const submit = () => {
    if (!choice) return
    setActionError(null)
    setBusy(true)
    respondToQuote(token, {
      action: choice,
      amountCents: needsAmount && amountCents !== null ? amountCents : undefined,
      reason: choice === 'DECLINE' ? reason : undefined,
      message: message.trim() || undefined,
      name: name.trim(),
      email: email.trim(),
    })
      .then(() => setDone(choice))
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Could not send your answer')
      })
      .finally(() => setBusy(false))
  }

  const equipment = view.equipmentType ? `${view.equipmentType}${view.equipmentLengthFt ? ` · ${view.equipmentLengthFt} ft` : ''}` : null
  const submitTone = choice === 'DECLINE' || choice === 'PASS' ? 'destructive' : 'primary'

  return (
    <Shell broker={view.brokerName} title={`${sell ? 'Your quote' : 'Load offer'} — ${view.quoteNumber}`} width="lg">
      <div className="tms-public-stack">
        <p className="tms-public-intro">
          {sell
            ? `${view.brokerName} is quoting this freight at `
            : `${view.brokerName} is offering this load at `}
          <span className="tms-public-strong">{money(view.amountCents)}</span>.
          {countdown && (
            <span className="tms-public-countdown">
              <Clock size={13} />
              {countdown} left to answer.
            </span>
          )}
        </p>

        {/* The freight, as this side is allowed to see it. */}
        <TmsCard title="The freight">
          <ol className="tms-public-stops">
            {view.stops.map((stop) => (
              <li key={`${stop.sequence}-${stop.type}`}>
                <span className="tms-public-stop-type">{stop.type.toLowerCase()}</span>
                {' — '}
                {[stop.city, stop.state].filter(Boolean).join(', ') || 'to be confirmed'}
                {stop.appt && <span className="tms-muted"> · {whenText(stop.appt)}</span>}
              </li>
            ))}
          </ol>
          <TmsMetaList
            columns={2}
            items={[
              { label: 'Equipment', value: equipment, hidden: !equipment },
              { label: 'Mode', value: view.mode, hidden: !view.mode },
              { label: 'Commodity', value: view.commodity, hidden: !view.commodity },
              { label: 'Weight', value: `${view.weightLbs} lbs`, hidden: view.weightLbs == null },
              { label: 'Miles', value: String(view.miles), hidden: view.miles == null },
            ]}
          />
        </TmsCard>

        {/* SELL: the lines behind the price. BUY: their own last number. */}
        {sell && view.lines.length > 0 && (
          <TmsCard title="The price" flush>
            <table className="tms-table tms-public-price" aria-label="Price breakdown">
              <tbody>
                {view.lines.map((line, index) => (
                  <tr key={`${line.label}-${index}`}>
                    <td>{line.label}</td>
                    <td className="tms-public-amount">{money(line.amountCents)}</td>
                  </tr>
                ))}
                <tr className="tms-public-total">
                  <td>Total</td>
                  <td className="tms-public-amount">{money(view.amountCents)}</td>
                </tr>
              </tbody>
            </table>
          </TmsCard>
        )}

        {!sell && (view.bookNowRateCents != null || view.theirAmountCents != null) && (
          <TmsCard>
            {view.bookNowRateCents != null && (
              <p className="text-sm">
                Take it now at <strong>{money(view.bookNowRateCents)}</strong>.
              </p>
            )}
            {view.theirAmountCents != null && (
              <p className="text-sm tms-muted">
                Your last number was {money(view.theirAmountCents)}.
              </p>
            )}
          </TmsCard>
        )}

        {view.message && (
          <TmsCard title={`From ${view.brokerName}`}>
            <p className="tms-public-message">{view.message}</p>
          </TmsCard>
        )}

        {/* The answer. */}
        <TmsCard title="Your answer">
          <div className="tms-public-choices">
            {sell ? (
              <>
                <ChoiceButton active={choice === 'ACCEPT'} tone="primary" onClick={() => setChoice('ACCEPT')}>
                  <CheckCircle2 size={15} /> Accept {money(view.amountCents)}
                </ChoiceButton>
                <ChoiceButton active={choice === 'COUNTER'} onClick={() => setChoice('COUNTER')}>
                  Counter
                </ChoiceButton>
                <ChoiceButton active={choice === 'DECLINE'} onClick={() => setChoice('DECLINE')}>
                  <XCircle size={15} /> Decline
                </ChoiceButton>
              </>
            ) : (
              <>
                <ChoiceButton active={choice === 'QUOTE'} tone="primary" onClick={() => setChoice('QUOTE')}>
                  Quote a rate
                </ChoiceButton>
                <ChoiceButton active={choice === 'ACCEPT'} onClick={() => setChoice('ACCEPT')}>
                  <CheckCircle2 size={15} /> Accept {money(view.bookNowRateCents ?? view.amountCents)}
                </ChoiceButton>
                <ChoiceButton active={choice === 'COUNTER'} onClick={() => setChoice('COUNTER')}>
                  Counter
                </ChoiceButton>
                <ChoiceButton active={choice === 'PASS'} onClick={() => setChoice('PASS')}>
                  <XCircle size={15} /> Pass
                </ChoiceButton>
              </>
            )}
          </div>

          {needsAmount && (
            <div className="tms-public-field">
              <label className="tms-public-label" htmlFor="quote-amount">
                {choice === 'QUOTE' ? 'Your rate' : 'Your number'}
              </label>
              <TmsInput
                id="quote-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}

          {choice === 'DECLINE' && (
            <div className="tms-public-field">
              <label className="tms-public-label" htmlFor="quote-reason">Why</label>
              <TmsSelect
                id="quote-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as QuoteLostReason)}
              >
                {PUBLIC_DECLINE_REASONS.map((value) => (
                  <option key={value} value={value}>{DECLINE_LABELS[value]}</option>
                ))}
              </TmsSelect>
            </div>
          )}

          {choice && (
            <>
              <div className="tms-public-field">
                <label className="tms-public-label" htmlFor="quote-message">Anything to add</label>
                <TmsTextarea
                  id="quote-message"
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>

              <div className="tms-public-grid-2">
                <div className="tms-public-field">
                  <label className="tms-public-label" htmlFor="quote-name">Your name</label>
                  <TmsInput id="quote-name" autoComplete="name" value={name}
                    onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="tms-public-field">
                  <label className="tms-public-label" htmlFor="quote-email">Your e-mail</label>
                  <TmsInput id="quote-email" type="email" autoComplete="email" value={email}
                    onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {actionError && <TmsAlert tone="red">{actionError}</TmsAlert>}

          <div className="tms-public-actions">
            <TmsButton variant={submitTone} disabled={!canSubmit} onClick={submit}>
              <Send size={15} /> {busy ? 'Sending…' : 'Send my answer'}
            </TmsButton>
            {!choice && (
              <span className="tms-public-sub">Pick one of the above first.</span>
            )}
            {choice && (name.trim() === '' || !email.includes('@')) && (
              <span className="tms-public-sub">Your name and e-mail go on the record.</span>
            )}
          </div>
        </TmsCard>

        {view.terms && (
          <p className="tms-public-terms">{view.terms}</p>
        )}
      </div>
    </Shell>
  )
}

function ChoiceButton({ active, tone, onClick, children }: {
  active: boolean
  tone?: 'primary'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <TmsButton
      variant={tone === 'primary' ? 'primary' : 'secondary'}
      className={active ? 'tms-public-choice tms-public-choice-active' : 'tms-public-choice'}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </TmsButton>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'good'; title: string; children: ReactNode }) {
  return (
    <TmsAlert tone={tone === 'good' ? 'green' : 'orange'} title={title}>
      {children}
    </TmsAlert>
  )
}

function Shell({ children, broker, title, width = 'md' }: { children: ReactNode; broker?: string; title?: string; width?: 'md' | 'lg' }) {
  return (
    <TmsPublicFrame brand={broker ?? 'BCAT'} subtitle="Quote" title={title} width={width}>
      {children}
    </TmsPublicFrame>
  )
}

export default QuoteRespondPage
