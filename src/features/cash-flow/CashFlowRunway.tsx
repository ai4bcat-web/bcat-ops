import { Fuel, TrendingDown, TrendingUp, Wallet, Info, AlertTriangle } from 'lucide-react'
import { fmtCents, runwayLabel, type Runway } from '@/lib/cashFlow'

const GREEN = '#15803d'
const RED = '#dc2626'
const AMBER = '#b45309'

/** Under 3 months is a fire; under 6 is a warning. */
function tone(r: Runway): { color: string; verdict: string } {
  if (r.monthsRemaining == null) return { color: GREEN, verdict: "You're not burning cash" }
  if (r.monthsRemaining <= 2) return { color: RED, verdict: 'Critical — act now' }
  if (r.monthsRemaining <= 5) return { color: AMBER, verdict: 'Tight — worth planning for' }
  return { color: 'var(--ds-t1)', verdict: 'Comfortable for now' }
}

function Stat({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div style={{ flex: 1, minWidth: 180, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--ds-t3)', fontWeight: 600 }}>
        {icon}{label}
      </div>
      <div style={{ marginTop: 4, fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em',
        color: color ?? 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && <div style={{ marginTop: 2, fontSize: 11, color: 'var(--ds-t3)' }}>{sub}</div>}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '8px 12px', fontSize: 11.5, fontWeight: 600, color: 'var(--ds-t3)',
  textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)',
}
const td: React.CSSProperties = {
  padding: '8px 12px', fontSize: 12.5, textAlign: 'right', whiteSpace: 'nowrap',
  color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--ds-border)',
}

/**
 * Runway — how long the cash lasts, given this week's inputs.
 *
 * The month-by-month walk is kept underneath the headline because the first two months
 * aren't representative: they carry the 30-day AR, the aged AR and the payables clearing.
 * The steady monthly net is the number that actually decides whether runway is finite.
 */
export function CashFlowRunway({ runway, suggestedSpread, currentSpread }: {
  runway: Runway
  /** Smallest payables spread that clears the floor, or null if deferring can't fix it. */
  suggestedSpread: number | null
  currentSpread: number
}) {
  const t = tone(runway)
  const burning = runway.steadyNetCents < 0

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Fuel size={16} style={{ color: 'var(--ds-blue)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Runway</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>How long the cash lasts on this week's figures</div>
        </div>
      </div>

      {/* The headline answer, big enough to read at a glance. */}
      <div style={{ padding: '22px 20px 18px', borderBottom: '1px solid var(--ds-border)' }}>
        <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1, color: t.color }}>
          {runwayLabel(runway)}
        </div>
        <div style={{ marginTop: 5, fontSize: 13, color: 'var(--ds-t2)' }}>
          {runway.monthsRemaining == null
            ? `${t.verdict} — a steady month adds ${fmtCents(runway.steadyNetCents)}.`
            : runway.alreadyBelow
              ? `Already below your minimum-cash floor. ${t.verdict}.`
              : `${t.verdict} — cash drops below your floor in ${runway.runsOutLabel}.`}
        </div>
      </div>

      {runway.temporaryDipLabel && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '16px 20px 0',
          padding: '10px 12px', borderRadius: 9, border: `1px solid ${AMBER}33`, background: `${AMBER}0f` }}>
          <AlertTriangle size={14} style={{ color: AMBER, flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, color: AMBER, lineHeight: 1.55 }}>
            <strong>Cash dips below your floor in {runway.temporaryDipLabel}, then recovers.</strong>{' '}
            That's every payable clearing at once before the month's revenue lands — it doesn't
            end your runway, but it's the month you could actually come up short.
            {suggestedSpread != null && suggestedSpread > currentSpread && (
              <> Spreading the payables over <strong>{suggestedSpread} months</strong> clears it —
              the same total still goes out, just later.</>
            )}
            {suggestedSpread == null && (
              <> Staggering won't fix this one: the shortfall is bigger than deferring can cover.</>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, padding: '16px 20px', flexWrap: 'wrap' }}>
        <Stat icon={<Wallet size={13} />} label="Cash on hand today"
          value={fmtCents(runway.startingCashCents)} />
        <Stat
          icon={burning ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
          label={burning ? 'Burn per steady month' : 'Added per steady month'}
          value={fmtCents(Math.abs(runway.steadyNetCents))}
          color={burning ? RED : GREEN}
          sub="recurring revenue − recurring expenses"
        />
        <Stat icon={<Fuel size={13} />} label="Runs out"
          value={runway.runsOutLabel ?? 'Not within 5 years'}
          color={runway.runsOutLabel ? t.color : GREEN} />
      </div>

      <div style={{ overflowX: 'auto', borderTop: '1px solid var(--ds-border)' }}>
        <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Month</th>
              <th style={th}>Opening</th>
              <th style={th}>Net</th>
              <th style={th}>Closing</th>
            </tr>
          </thead>
          <tbody>
            {runway.months.map((m) => (
              <tr key={m.index}>
                <td style={{ ...td, textAlign: 'left', color: 'var(--ds-t2)' }}>{m.label}</td>
                <td style={{ ...td, color: 'var(--ds-t3)' }}>{fmtCents(m.openingCents)}</td>
                <td style={{ ...td, color: m.netCents < 0 ? RED : GREEN }}>{fmtCents(m.netCents)}</td>
                <td style={{ ...td, fontWeight: 600, color: m.closingCents < 0 ? RED : 'var(--ds-t1)' }}>
                  {fmtCents(m.closingCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '14px 20px 18px', borderTop: '1px solid var(--ds-border)' }}>
        <Info size={13} style={{ color: 'var(--ds-t3)', flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--ds-t2)' }}>How runway is worked out.</strong>{' '}
          The first two months aren't typical — month 1 collects the 30-day AR and clears the
          payables, month 2 collects the aged AR net of its collection rate. From month 3 on,
          every month is the same: recurring revenue minus recurring expenses. That steady
          figure is what decides whether the runway ends at all. Runway is measured against
          your minimum-cash threshold, not zero, so set it to the balance you actually need
          to keep on hand. A month that dips below and recovers is flagged separately — runway
          ends where the balance goes below and stays there, not at the first wobble.
        </div>
      </div>
    </div>
  )
}
