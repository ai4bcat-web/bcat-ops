import { useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { History, Plus, Trash2 } from 'lucide-react'
import { fmtCents, centsToDollars } from '@/lib/cashFlow'
import type { CashFlowWeekRow } from '@/lib/cashFlowClient'

const COLORS = { cash: '#1ea8f3', runway: '#b45309' }
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

function weekLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
}

const th: React.CSSProperties = {
  padding: '9px 12px', fontSize: 11.5, fontWeight: 600, color: 'var(--ds-t3)',
  textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)',
}
const td: React.CSSProperties = {
  padding: '9px 12px', fontSize: 12.5, textAlign: 'right', whiteSpace: 'nowrap',
  color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--ds-border)',
}

export function CashFlowWeeklyLog({ weeks, disabled, onLog, onDelete }: {
  weeks: CashFlowWeekRow[]
  disabled: boolean
  onLog: () => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  // Chart wants dollars — recharts axes get unreadable with cent-scale magnitudes.
  const series = useMemo(
    () => weeks.map((w) => ({
      label: weekLabel(w.weekOf),
      cash: Math.round(centsToDollars(w.totalCashCents)),
      // null (not burning) must stay null so recharts breaks the line rather than
      // drawing a plunge to zero that never happened.
      runway: w.runwayMonths ?? null,
    })),
    [weeks],
  )

  const logWeek = async () => {
    setBusy(true)
    try { await onLog() } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    setRemoving(id)
    try { await onDelete(id) } finally { setRemoving(null) }
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <History size={16} style={{ color: 'var(--ds-blue)' }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Weekly log</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>One snapshot per week — cash on hand against the runway it bought you</div>
        </div>
        <button
          onClick={() => void logWeek()}
          disabled={busy || disabled}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 8,
            border: '1px solid ' + (disabled ? 'var(--ds-border)' : 'var(--ds-blue)'),
            background: disabled ? 'var(--ds-surface)' : 'var(--ds-blue)',
            color: disabled ? 'var(--ds-t3)' : '#fff',
            fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: busy || disabled ? 'default' : 'pointer' }}
        >
          <Plus size={14} /> {busy ? 'Saving…' : 'Save this week to log'}
        </button>
      </div>

      {series.length >= 2 && (
        <div style={{ padding: '16px 12px 4px', height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--ds-border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--ds-t3)' }} tickLine={false} axisLine={{ stroke: 'var(--ds-border)' }} />
              <YAxis yAxisId="cash" tickFormatter={(v: number) => usdCompact.format(v)} tick={{ fontSize: 11, fill: 'var(--ds-t3)' }} tickLine={false} axisLine={false} width={62} />
              <YAxis yAxisId="runway" orientation="right" tickFormatter={(v: number) => `${v}mo`} tick={{ fontSize: 11, fill: 'var(--ds-t3)' }} tickLine={false} axisLine={false} width={46} />
              <Tooltip
                formatter={(value, name) => (name === 'Runway' ? `${Number(value)} mo` : usdCompact.format(Number(value)))}
                contentStyle={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 11.5 }} />
              <Line yAxisId="cash" type="monotone" dataKey="cash" name="Total cash" stroke={COLORS.cash} strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="runway" type="monotone" dataKey="runway" name="Runway" stroke={COLORS.runway} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {weeks.length === 0 ? (
        <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
          No weeks logged yet. Enter this week's figures above, then press <strong style={{ color: 'var(--ds-t2)' }}>Save this week to log</strong> to start the trend.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 780, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Week of</th>
                <th style={th}>Total cash</th>
                <th style={th}>30-day AR</th>
                <th style={th}>120-day AR</th>
                <th style={th}>Total payables</th>
                <th style={th}>Projected low</th>
                <th style={th}>Runway</th>
                <th style={{ ...th, width: 44 }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {[...weeks].reverse().map((w) => (
                <tr key={w.id}>
                  <td style={{ ...td, textAlign: 'left' }}>{w.weekOf.slice(0, 10)}</td>
                  <td style={td}>{fmtCents(w.totalCashCents)}</td>
                  <td style={td}>{fmtCents(w.ar30Cents)}</td>
                  <td style={td}>{fmtCents(w.ar120Cents)}</td>
                  <td style={td}>{fmtCents(w.totalPayablesCents)}</td>
                  <td style={{ ...td, color: w.projectedLowCents < 0 ? '#dc2626' : 'var(--ds-t1)' }}>{fmtCents(w.projectedLowCents)}</td>
                  <td style={{ ...td, fontWeight: 600, color: w.runwayMonths == null ? '#15803d' : w.runwayMonths <= 2 ? '#dc2626' : 'var(--ds-t1)' }}>
                    {w.runwayMonths == null ? 'No limit' : `${w.runwayMonths} mo`}
                  </td>
                  <td style={{ ...td, padding: '6px 10px' }}>
                    <button
                      onClick={() => void remove(w.id)}
                      disabled={removing === w.id}
                      title={`Delete the week of ${w.weekOf.slice(0, 10)}`}
                      aria-label={`Delete the week of ${w.weekOf.slice(0, 10)}`}
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26,
                        borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)',
                        color: '#b91c1c', cursor: removing === w.id ? 'wait' : 'pointer' }}
                    >
                      <Trash2 size={12.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
