import { useState } from 'react'
import { Receipt } from 'lucide-react'
import { useFleetFixedCosts, type FleetFixedCostKey } from '@/hooks/useFleetFixedCosts'

const ROWS: { key: FleetFixedCostKey; label: string }[] = [
  { key: 'loanTrailers', label: 'Loan — trailers' },
  { key: 'trailerLease', label: 'Trailer lease' },
  { key: 'yardRent',     label: 'Yard rent' },
  { key: 'tolls',        label: 'Tolls' },
]

/** Editable "$[input] /mo" row — commits the fixed monthly amount in place. */
function EditableCostRow({ label, amount, onCommit }: { label: string; amount: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (amount ? String(amount) : '')
  const commit = () => {
    if (draft == null) return
    const n = Math.max(0, parseFloat(draft) || 0)
    setDraft(null)
    if (n !== amount) onCommit(n)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderTop: '1px solid var(--tms-border)' }}>
      <span style={{ fontSize: 13, color: 'var(--tms-text-2)' }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--tms-text)' }}>
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: 8, color: 'var(--tms-muted)', fontSize: 12.5, pointerEvents: 'none' }}>$</span>
          <input
            type="number" min="0" step="1" inputMode="decimal"
            value={value} placeholder="0"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            aria-label={`${label} monthly amount`}
            style={{ width: 110, height: 30, padding: '0 8px 0 18px', textAlign: 'right', borderRadius: 7,
              border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)',
              fontSize: 13, fontVariantNumeric: 'tabular-nums', fontFamily: 'inherit', outline: 'none' }}
          />
        </span>
        <span style={{ fontSize: 11, color: 'var(--tms-muted)' }}>/mo</span>
      </span>
    </div>
  )
}

/**
 * Editable monthly fixed costs for the Ivan (LOCAL) fleet. These feed the Monthly P&L;
 * editing here updates this month and carries forward to following months.
 */
export function FleetExpensesCard() {
  const { monthlyAmounts, setMonthlyAmount } = useFleetFixedCosts()
  const handleEdit = (key: FleetFixedCostKey) => (n: number) => { void setMonthlyAmount(key, n) }

  return (
    <div style={{ background: 'var(--tms-card)', border: '1px solid var(--tms-border)', borderRadius: 12, boxShadow: 'var(--tms-shadow)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--tms-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Receipt size={16} style={{ color: 'var(--tms-primary)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tms-text)' }}>Monthly fixed costs</div>
          <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>Edit once — carries forward to following months</div>
        </div>
      </div>
      <div style={{ padding: '6px 20px 18px', maxWidth: 480 }}>
        {ROWS.map((row) => (
          <EditableCostRow key={row.key} label={row.label} amount={monthlyAmounts[row.key]} onCommit={handleEdit(row.key)} />
        ))}
        <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--tms-muted)', lineHeight: 1.5 }}>
          Loan-trucks and ELD are per-truck — set them in Fleet → Operating Costs. Fuel, driver pay,
          maintenance, insurance and permits flow in automatically from transactions.
        </div>
      </div>
    </div>
  )
}
