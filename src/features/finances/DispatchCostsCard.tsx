import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, Loader2 } from 'lucide-react'
import { listAllDispatchMessages, listDispatchConversations } from '@/lib/apiClient'
import { costReport, TWILIO_RATES, type CostReport } from '@/lib/dispatchCosts'
import { prettyPhone, type DispatchConversation, type DispatchMessage } from '@/lib/dispatch'

const WEEKS = 8

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

function weekLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Dispatch texting spend per driver, week over week, at Twilio's list rates. Twilio's
 * invoice is the final word; this is the running estimate from the messages we hold.
 */
export function DispatchCostsCard() {
  const [data, setData] = useState<{ conversations: DispatchConversation[]; messages: DispatchMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([listDispatchConversations(), listAllDispatchMessages()])
      .then(([conversations, messages]) => { if (alive) setData({ conversations, messages }) })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Could not load dispatch messages') })
    return () => { alive = false }
  }, [])
  const report: CostReport | null = useMemo(() => data ? costReport(data.conversations, data.messages, new Date(), WEEKS) : null, [data])
  const numberRental = TWILIO_RATES.numberPerMonth * 12 / 52

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <MessageSquare size={16} style={{ color: 'var(--ds-blue)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Dispatch texting (Twilio)</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Estimated at Twilio list rates from the messages in Dispatch · last {WEEKS} weeks, Sunday to Saturday</div>
        </div>
      </div>
      {error ? <div style={{ padding: 20, fontSize: 13, color: 'var(--ds-red)' }}>{error}</div>
        : !report ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Loader2 className="size-5 animate-spin" style={{ color: 'var(--ds-t3)' }} /></div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: 'var(--ds-t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ textAlign: 'left', padding: '10px 20px', fontWeight: 600 }}>Driver</th>
                  {report.weeks.map((w) => <th key={w} style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{weekLabel(w)}</th>)}
                  <th style={{ textAlign: 'right', padding: '10px 20px', fontWeight: 600 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {report.drivers.length === 0 ? (
                  <tr><td colSpan={report.weeks.length + 2} style={{ padding: 20, color: 'var(--ds-t3)' }}>No texts yet.</td></tr>
                ) : report.drivers.map((d) => (
                  <tr key={d.conversationId} style={{ borderTop: '1px solid var(--ds-border-soft)' }}>
                    <td style={{ padding: '9px 20px' }}>
                      <div style={{ color: 'var(--ds-t1)', fontWeight: 500 }}>{d.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>{prettyPhone(d.phone)} · {d.messages} texts</div>
                    </td>
                    {report.weeks.map((w) => {
                      const wk = d.weeks[w]
                      return (
                        <td key={w} style={{ textAlign: 'right', padding: '9px 12px', fontVariantNumeric: 'tabular-nums', color: wk ? 'var(--ds-t1)' : 'var(--ds-t3)' }} title={wk ? `${wk.messages} texts` : undefined}>
                          {wk ? money(wk.dollars) : '—'}
                        </td>
                      )
                    })}
                    <td style={{ textAlign: 'right', padding: '9px 20px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--ds-t1)' }}>{money(d.total)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid var(--ds-border)', background: 'var(--ds-bg-2)' }}>
                  <td style={{ padding: '9px 20px', color: 'var(--ds-t2)' }}>Number rental</td>
                  {report.weeks.map((w) => <td key={w} style={{ textAlign: 'right', padding: '9px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t2)' }}>{money(numberRental)}</td>)}
                  <td style={{ textAlign: 'right', padding: '9px 20px', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t2)' }}>{money(numberRental * report.weeks.length)}</td>
                </tr>
                <tr style={{ borderTop: '1px solid var(--ds-border)', fontWeight: 700 }}>
                  <td style={{ padding: '10px 20px', color: 'var(--ds-t1)' }}>Total</td>
                  {report.weeks.map((w) => <td key={w} style={{ textAlign: 'right', padding: '10px 12px', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(report.weekTotals[w] + numberRental)}</td>)}
                  <td style={{ textAlign: 'right', padding: '10px 20px', fontVariantNumeric: 'tabular-nums', color: 'var(--ds-t1)' }}>{money(report.grandTotal + numberRental * report.weeks.length)}</td>
                </tr>
              </tbody>
            </table>
            <div style={{ padding: '10px 20px 16px', fontSize: 11.5, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
              Rates: SMS ${TWILIO_RATES.smsOutPerSegment.toFixed(4)} per segment each way plus ${TWILIO_RATES.carrierSms.toFixed(4)} carrier fee; MMS ${TWILIO_RATES.mmsOut.toFixed(3)} out / ${TWILIO_RATES.mmsIn.toFixed(3)} in plus ${TWILIO_RATES.carrierMms.toFixed(3)} carrier fee;
              answered calls ${(TWILIO_RATES.voiceInPerMin + TWILIO_RATES.voiceOutPerMin).toFixed(4)} per minute (both legs); number ${TWILIO_RATES.numberPerMonth.toFixed(2)} per month. Internal notes and status updates are free.
            </div>
          </div>
        )}
    </div>
  )
}
