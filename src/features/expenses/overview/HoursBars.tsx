import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { DriverHours } from '@/lib/expenseOverview'
import { minutesLabel } from '@/lib/timeClock'
import { useTmsTokens } from '@/features/tms/tmsTokens'

const TOKENS = ['--tms-chart-1', '--tms-chart-axis', '--tms-chart-grid'] as const
const ROW_PX = 32

/**
 * Hours worked per time-clock driver as horizontal bars. The visually hidden table is the
 * accessible fallback and what tests read (recharts measures 0×0 in jsdom).
 */
export function HoursBars({ rows, ariaLabel }: { rows: DriverHours[]; ariaLabel: string }) {
  const tok = useTmsTokens(TOKENS)
  return (
    <div>
      <div role="img" aria-label={ariaLabel} data-testid="hours-bars">
        <ResponsiveContainer width="100%" height={Math.max(96, rows.length * ROW_PX + 32)}>
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }} barCategoryGap="28%">
            <CartesianGrid stroke={tok['--tms-chart-grid']} strokeDasharray="3 4" horizontal={false} />
            <XAxis type="number" tick={{ fill: tok['--tms-chart-axis'], fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" width={110} tick={{ fill: tok['--tms-chart-axis'], fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: tok['--tms-chart-grid'] }}
              formatter={(_value, _name, item) => minutesLabel((item.payload as DriverHours).minutes)}
              contentStyle={{ background: 'var(--tms-tooltip-bg)', color: 'var(--tms-tooltip-ink)', border: 'none', borderRadius: 8, fontSize: 12, boxShadow: 'var(--tms-shadow-pop)' }}
            />
            <Bar dataKey="hours" name="Hours" fill={tok['--tms-chart-1']} radius={[0, 999, 999, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr><th scope="col">Driver</th><th scope="col">Hours worked</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.driverId}><th scope="row">{r.name}</th><td>{minutesLabel(r.minutes)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
