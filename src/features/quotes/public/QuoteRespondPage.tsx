import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Clock, Send, XCircle } from 'lucide-react'
import {
  fetchQuoteLink, quoteLinkAvailable, respondToQuote, QuoteLinkError,
  type QuotePublicView,
} from '@/lib/quoteLinkClient'
import { PUBLIC_DECLINE_REASONS } from '@/lib/quotes'
import type { QuoteLostReason } from '@/types/tms'

// This page is PUBLIC — a customer or a carrier opens it from an emailed link with no
// account. It must never import anything that needs Cognito (no useAuth, no apiClient);
// the only backend it talks to is the tracking API's /q/<token> routes via
// quoteLinkClient. It renders only what `QuotePublicView` carries: the view is built by
// an allow-list server-side, and nothing here may reach for a field beside it.

// ── Shared styles (design-system tokens, matching the rate-con portal) ─────────
const cardStyle: CSSProperties = {
  background: 'var(--ds-surface)',
  border: '1px solid var(--ds-border)',
  borderRadius: 12,
  boxShadow: 'var(--sh-sm)',
  padding: 14,
}
const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  borderRadius: 9, padding: '11px 22px', fontSize: 14, fontWeight: 600,
  background: 'var(--ds-blue)', color: '#fff', border: 'none', cursor: 'pointer',
}
const btnGhost: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7,
  borderRadius: 9, padding: '11px 18px', fontSize: 14, fontWeight: 600,
  background: 'var(--ds-surface)', color: 'var(--ds-t2)',
  border: '1px solid var(--ds-border)', cursor: 'pointer',
}
const btnDanger: CSSProperties = { ...btnPrimary, background: 'var(--ds-red)' }
const inputStyle: CSSProperties = {
  width: '100%', borderRadius: 7, border: '1px solid var(--ds-border)', padding: '9px 12px',
  fontSize: 14, background: 'var(--ds-surface)', color: 'var(--ds-t1)', outline: 'none',
}
const labelStyle: CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--ds-t3)', marginBottom: 4,
}
const PORTAL_COL = 'mx-auto w-full px-6 py-8'
const PORTAL_MAXW: CSSProperties = { maxWidth: 720 }

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
    return <Shell><div className="px-4 py-16 text-center" style={{ color: 'var(--ds-t3)' }}>Loading…</div></Shell>
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

  return (
    <Shell broker={view.brokerName}>
      <div className={PORTAL_COL} style={PORTAL_MAXW}>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--ds-t1)' }}>
          {sell ? 'Your quote' : 'Load offer'} — {view.quoteNumber}
        </h1>
        <p className="mt-1" style={{ color: 'var(--ds-t3)' }}>
          {sell
            ? `${view.brokerName} is quoting this freight at `
            : `${view.brokerName} is offering this load at `}
          <span style={{ fontWeight: 600, color: 'var(--ds-t2)' }}>{money(view.amountCents)}</span>.
          {countdown && (
            <span style={{ marginLeft: 6 }}>
              <Clock size={13} style={{ display: 'inline', marginRight: 4, verticalAlign: '-2px' }} />
              {countdown} left to answer.
            </span>
          )}
        </p>

        {/* The freight, as this side is allowed to see it. */}
        <div className="mt-4" style={cardStyle}>
          <div className="mb-2 text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>The freight</div>
          <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--ds-t2)', fontSize: 14 }}>
            {view.stops.map((stop) => (
              <li key={`${stop.sequence}-${stop.type}`} style={{ marginBottom: 4 }}>
                <span style={{ textTransform: 'capitalize' }}>{stop.type.toLowerCase()}</span>
                {' — '}
                {[stop.city, stop.state].filter(Boolean).join(', ') || 'to be confirmed'}
                {stop.appt && <span style={{ color: 'var(--ds-t3)' }}> · {whenText(stop.appt)}</span>}
              </li>
            ))}
          </ol>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm" style={{ color: 'var(--ds-t2)' }}>
            {view.equipmentType && <Pair label="Equipment" value={`${view.equipmentType}${view.equipmentLengthFt ? ` · ${view.equipmentLengthFt} ft` : ''}`} />}
            {view.mode && <Pair label="Mode" value={view.mode} />}
            {view.commodity && <Pair label="Commodity" value={view.commodity} />}
            {view.weightLbs != null && <Pair label="Weight" value={`${view.weightLbs} lbs`} />}
            {view.miles != null && <Pair label="Miles" value={String(view.miles)} />}
          </dl>
        </div>

        {/* SELL: the lines behind the price. BUY: their own last number. */}
        {sell && view.lines.length > 0 && (
          <div className="mt-4" style={cardStyle}>
            <div className="mb-2 text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>The price</div>
            <table style={{ width: '100%', fontSize: 14, color: 'var(--ds-t2)' }}>
              <tbody>
                {view.lines.map((line, index) => (
                  <tr key={`${line.label}-${index}`}>
                    <td style={{ padding: '3px 0' }}>{line.label}</td>
                    <td style={{ padding: '3px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {money(line.amountCents)}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid var(--ds-border)' }}>
                  <td style={{ padding: '6px 0', fontWeight: 600 }}>Total</td>
                  <td style={{ padding: '6px 0', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {money(view.amountCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {!sell && (view.bookNowRateCents != null || view.theirAmountCents != null) && (
          <div className="mt-4" style={cardStyle}>
            {view.bookNowRateCents != null && (
              <p className="text-sm" style={{ color: 'var(--ds-t2)' }}>
                Take it now at <strong>{money(view.bookNowRateCents)}</strong>.
              </p>
            )}
            {view.theirAmountCents != null && (
              <p className="text-sm" style={{ color: 'var(--ds-t3)' }}>
                Your last number was {money(view.theirAmountCents)}.
              </p>
            )}
          </div>
        )}

        {view.message && (
          <div className="mt-4" style={cardStyle}>
            <div className="mb-1 text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>From {view.brokerName}</div>
            <p className="whitespace-pre-wrap text-sm" style={{ color: 'var(--ds-t2)' }}>{view.message}</p>
          </div>
        )}

        {/* The answer. */}
        <div className="mt-4" style={cardStyle}>
          <div className="mb-3 text-sm font-semibold" style={{ color: 'var(--ds-t1)' }}>Your answer</div>

          <div className="flex flex-wrap gap-2.5">
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
            <div className="mt-3">
              <label style={labelStyle} htmlFor="quote-amount">
                {choice === 'QUOTE' ? 'Your rate' : 'Your number'}
              </label>
              <input
                id="quote-amount"
                inputMode="decimal"
                placeholder="0.00"
                style={inputStyle}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}

          {choice === 'DECLINE' && (
            <div className="mt-3">
              <label style={labelStyle} htmlFor="quote-reason">Why</label>
              <select
                id="quote-reason"
                style={inputStyle}
                value={reason}
                onChange={(e) => setReason(e.target.value as QuoteLostReason)}
              >
                {PUBLIC_DECLINE_REASONS.map((value) => (
                  <option key={value} value={value}>{DECLINE_LABELS[value]}</option>
                ))}
              </select>
            </div>
          )}

          {choice && (
            <>
              <div className="mt-3">
                <label style={labelStyle} htmlFor="quote-message">Anything to add</label>
                <textarea
                  id="quote-message"
                  rows={2}
                  style={{ ...inputStyle, resize: 'vertical' }}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle} htmlFor="quote-name">Your name</label>
                  <input id="quote-name" autoComplete="name" style={inputStyle} value={name}
                    onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="quote-email">Your e-mail</label>
                  <input id="quote-email" type="email" autoComplete="email" style={inputStyle} value={email}
                    onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {actionError && <p className="mt-3 text-sm" style={{ color: 'var(--ds-red)' }}>{actionError}</p>}

          <div className="mt-4 flex items-center gap-2.5">
            <button
              type="button"
              style={{
                ...(choice === 'DECLINE' || choice === 'PASS' ? btnDanger : btnPrimary),
                opacity: canSubmit ? 1 : 0.5,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
              disabled={!canSubmit}
              onClick={submit}
            >
              <Send size={15} /> {busy ? 'Sending…' : 'Send my answer'}
            </button>
            {!choice && (
              <span className="text-xs" style={{ color: 'var(--ds-t3)' }}>Pick one of the above first.</span>
            )}
            {choice && (name.trim() === '' || !email.includes('@')) && (
              <span className="text-xs" style={{ color: 'var(--ds-t3)' }}>Your name and e-mail go on the record.</span>
            )}
          </div>
        </div>

        {view.terms && (
          <p className="mt-4 whitespace-pre-wrap text-xs" style={{ color: 'var(--ds-t3)' }}>{view.terms}</p>
        )}
      </div>
    </Shell>
  )
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ds-t3)' }}>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function ChoiceButton({ active, tone, onClick, children }: {
  active: boolean
  tone?: 'primary'
  onClick: () => void
  children: ReactNode
}) {
  const base = tone === 'primary' ? btnPrimary : btnGhost
  return (
    <button
      type="button"
      style={{ ...base, outline: active ? '2px solid var(--ds-blue)' : 'none', outlineOffset: 2 }}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'good'; title: string; children: ReactNode }) {
  const Icon = tone === 'good' ? CheckCircle2 : AlertTriangle
  const color = tone === 'good' ? 'var(--ds-green)' : 'var(--ds-amber)'
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <Icon className="mx-auto mb-4" size={40} style={{ color }} />
      <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--ds-t1)' }}>{title}</h1>
      <p style={{ color: 'var(--ds-t3)' }}>{children}</p>
    </div>
  )
}

function Shell({ children, broker }: { children: ReactNode; broker?: string }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--ds-bg)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: '#0e1116', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="mx-auto flex w-full items-center gap-3 px-6" style={{ ...PORTAL_MAXW, height: 60 }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'linear-gradient(135deg, var(--ds-blue) 0%, var(--ds-blue-dark) 100%)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h7a4 4 0 0 1 0 8H5z M5 12h8a4 4 0 0 1 0 8H5z" fill="white" /></svg>
          </div>
          <div>
            <div className="text-sm font-bold" style={{ color: '#fff', letterSpacing: '0.02em' }}>{broker ?? 'BCAT'}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 1 }}>Quote</div>
          </div>
        </div>
      </header>
      <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: '100%', maxWidth: 720 }}>{children}</div>
      </main>
    </div>
  )
}

export default QuoteRespondPage
