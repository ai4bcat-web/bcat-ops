import { useState } from 'react'
import { Wallet, Save, Check } from 'lucide-react'
import { centsToDollars, dollarsToCents, fmtCents, num, type CashFlowInputs } from '@/lib/cashFlow'

/**
 * Money field: shows dollars, stores cents. Keeps a local draft string while focused so
 * typing "1200" doesn't fight a reformat mid-keystroke; commits to cents on blur.
 */
function MoneyField({ label, cents, onCommit, hint }: {
  label: string
  cents: number
  onCommit: (cents: number) => void
  hint?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (cents ? String(centsToDollars(cents)) : '')

  const commit = () => {
    if (draft == null) return
    const next = Math.max(0, dollarsToCents(draft))
    setDraft(null)
    if (next !== cents) onCommit(next)
  }

  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
      <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
        {label}
        {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--ds-t3)', marginTop: 1 }}>{hint}</span>}
      </span>
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ position: 'absolute', left: 8, color: 'var(--ds-t3)', fontSize: 12.5, pointerEvents: 'none' }}>$</span>
        <input
          type="number" min="0" step="1" inputMode="decimal"
          value={value} placeholder="0"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          aria-label={label}
          style={{ width: 130, height: 30, padding: '0 8px 0 18px', textAlign: 'right', borderRadius: 7,
            border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)',
            fontSize: 13, fontVariantNumeric: 'tabular-nums', fontFamily: 'inherit', outline: 'none' }}
        />
      </span>
    </label>
  )
}

/** Read-only computed row — same rhythm as the money fields so the panel reads as one list. */
function ComputedRow({ label, cents }: { label: string; cents: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--ds-border)' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', paddingRight: 8 }}>
        {fmtCents(cents)}
      </span>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)', marginBottom: 2 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

export function CashFlowInputsCard({ inputs, totalCash, totalPayables, dirty, saving, disabled, onField, onSave }: {
  inputs: CashFlowInputs
  totalCash: number
  totalPayables: number
  dirty: boolean
  saving: boolean
  disabled: boolean
  onField: <K extends keyof CashFlowInputs>(key: K, value: CashFlowInputs[K]) => void
  onSave: () => void
}) {
  const [rateDraft, setRateDraft] = useState<string | null>(null)
  const ratePct = rateDraft ?? String(Math.round(num(inputs.ar120CollectionRate) * 100))

  const commitRate = () => {
    if (rateDraft == null) return
    const pct = Math.min(Math.max(num(rateDraft), 0), 100)
    setRateDraft(null)
    onField('ar120CollectionRate', pct / 100)
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Wallet size={16} style={{ color: 'var(--ds-blue)' }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>This week's inputs</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Overwrite each week — every figure is entered by hand</div>
        </div>
        <button
          onClick={onSave}
          disabled={saving || disabled || !dirty}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 8,
            border: '1px solid ' + (dirty && !disabled ? 'var(--ds-blue)' : 'var(--ds-border)'),
            background: dirty && !disabled ? 'var(--ds-blue)' : 'var(--ds-surface)',
            color: dirty && !disabled ? '#fff' : 'var(--ds-t3)',
            fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            cursor: saving || disabled || !dirty ? 'default' : 'pointer' }}
        >
          {dirty ? <Save size={14} /> : <Check size={14} />}
          {saving ? 'Saving…' : dirty ? 'Save inputs' : 'Saved'}
        </button>
      </div>

      <div style={{ padding: '14px 20px 20px', display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <Group title="Week">
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
              Week of
            </span>
            <input
              type="date"
              value={inputs.weekOf?.slice(0, 10) ?? ''}
              onChange={(e) => onField('weekOf', e.target.value)}
              aria-label="Week of"
              style={{ width: 148, height: 30, padding: '0 8px', borderRadius: 7, border: '1px solid var(--ds-border)',
                background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
            />
          </label>
          <MoneyField label="Minimum cash threshold" hint="Low-point KPI turns red below this"
            cents={inputs.minCashThresholdCents} onCommit={(c) => onField('minCashThresholdCents', c)} />
        </Group>

        <Group title="Cash on hand">
          <MoneyField label="Cash — BCAT" cents={inputs.cashBcatCents} onCommit={(c) => onField('cashBcatCents', c)} />
          <MoneyField label="Cash — IVAN" cents={inputs.cashIvanCents} onCommit={(c) => onField('cashIvanCents', c)} />
          <ComputedRow label="Total cash" cents={totalCash} />
        </Group>

        <Group title="Receivables">
          <MoneyField label="30-day AR" cents={inputs.ar30Cents} onCommit={(c) => onField('ar30Cents', c)} />
          <MoneyField label="120-day AR (aged)" cents={inputs.ar120Cents} onCommit={(c) => onField('ar120Cents', c)} />
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>120-day collection rate</span>
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input
                type="number" min="0" max="100" step="1" inputMode="decimal"
                value={ratePct}
                onChange={(e) => setRateDraft(e.target.value)}
                onBlur={commitRate}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                aria-label="120-day AR collection rate"
                style={{ width: 130, height: 30, padding: '0 22px 0 8px', textAlign: 'right', borderRadius: 7,
                  border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)',
                  fontSize: 13, fontVariantNumeric: 'tabular-nums', fontFamily: 'inherit', outline: 'none' }}
              />
              <span style={{ position: 'absolute', right: 9, color: 'var(--ds-t3)', fontSize: 12.5, pointerEvents: 'none' }}>%</span>
            </span>
          </label>
        </Group>

        <Group title="Payables">
          <MoneyField label="BCAT aging (overdue)" cents={inputs.apBcatAgingCents} onCommit={(c) => onField('apBcatAgingCents', c)} />
          <MoneyField label="BCAT expected" cents={inputs.apBcatExpectedCents} onCommit={(c) => onField('apBcatExpectedCents', c)} />
          <MoneyField label="BCAT AMEX" cents={inputs.apBcatAmexCents} onCommit={(c) => onField('apBcatAmexCents', c)} />
          <MoneyField label="IVAN CC" cents={inputs.apIvanCcCents} onCommit={(c) => onField('apIvanCcCents', c)} />
          <MoneyField label="IVAN misc payables" cents={inputs.apIvanMiscCents} onCommit={(c) => onField('apIvanMiscCents', c)} />
          <ComputedRow label="Total payables" cents={totalPayables} />

          {/* Staggering is a timing lever: the same total goes out either way, it just
              stops month 1 absorbing the whole backlog before the month's revenue lands. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
              Pay over
              <span style={{ display: 'block', fontSize: 11, color: 'var(--ds-t3)', marginTop: 1 }}>
                Stagger the backlog to lift the month-1 trough
              </span>
            </span>
            <div style={{ display: 'flex', gap: 4, paddingRight: 8 }}>
              {[1, 2, 3, 4].map((n) => {
                const active = (inputs.payablesSpreadMonths || 1) === n
                return (
                  <button key={n} onClick={() => onField('payablesSpreadMonths', n)}
                    aria-label={`Spread payables over ${n} month${n === 1 ? '' : 's'}`}
                    aria-pressed={active}
                    style={{ minWidth: 34, height: 26, padding: '0 8px', borderRadius: 6, fontSize: 11.5,
                      fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                      border: '1px solid ' + (active ? 'var(--ds-blue)' : 'var(--ds-border)'),
                      background: active ? 'var(--ds-blue)' : 'var(--ds-surface)',
                      color: active ? '#fff' : 'var(--ds-t2)' }}>
                    {n === 1 ? 'Now' : `${n}mo`}
                  </button>
                )
              })}
            </div>
          </div>
        </Group>

        <Group title="Monthly run-rate">
          <MoneyField label="Recurring revenue / month" cents={inputs.recurringRevenueCents} onCommit={(c) => onField('recurringRevenueCents', c)} />
          <MoneyField label="Recurring operating expenses / month" cents={inputs.recurringExpensesCents} onCommit={(c) => onField('recurringExpensesCents', c)} />
        </Group>



      </div>
    </div>
  )
}
