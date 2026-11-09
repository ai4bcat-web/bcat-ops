import { FIRST_MONTH, clampRange, type MonthRange } from './brokerageFormat'

export interface Preset { key: string; label: string; range: (current: string) => MonthRange }

export function RangePicker({ label, range, current, presets, onChange }: {
  label: string
  range: MonthRange
  current: string
  presets: Preset[]
  onChange: (range: MonthRange) => void
}) {
  const input = { padding: '3px 6px', borderRadius: 6, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 12, fontFamily: 'inherit' } as const
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 4, background: 'var(--tms-bg)', border: '1px solid var(--tms-border)', borderRadius: 9, padding: 3 }}>
        {presets.map((p) => {
          const r = p.range(current)
          const on = r.from === range.from && r.to === range.to
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onChange(clampRange(r, current))}
              style={{
                padding: '3px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                fontWeight: on ? 600 : 500, background: on ? 'var(--tms-card)' : 'transparent', color: on ? 'var(--tms-text)' : 'var(--tms-muted)',
                boxShadow: on ? 'var(--tms-shadow)' : 'none',
              }}
            >
              {p.label}
            </button>
          )
        })}
      </div>
      <label style={{ fontSize: 12, color: 'var(--tms-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        From
        <input type="month" aria-label={`${label} from month`} value={range.from} min={FIRST_MONTH} max={current} style={input}
          onChange={(e) => { if (e.target.value) onChange(clampRange({ from: e.target.value, to: range.to }, current)) }} />
      </label>
      <label style={{ fontSize: 12, color: 'var(--tms-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        To
        <input type="month" aria-label={`${label} to month`} value={range.to} min={FIRST_MONTH} max={current} style={input}
          onChange={(e) => { if (e.target.value) onChange(clampRange({ from: range.from, to: e.target.value }, current)) }} />
      </label>
    </div>
  )
}
