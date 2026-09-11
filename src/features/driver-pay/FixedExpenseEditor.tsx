import { useMemo, useState, useEffect, useId } from 'react'
import { Plus, PenLine, Ban, X, Check } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { chicagoDateStr } from '@/lib/date'
import type { FixedExpenseInput } from '@/lib/driverPay'
import {
  prepareFixedExpenses,
  applyFixedExpenseChange,
  calculateMileageExpense,
  type FixedExpenseChange,
  type FixedExpenseAudit,
} from '@/lib/fixedExpenseHistory'

export type FixedExpenseEditorProps = {
  value: FixedExpenseInput[]
  onChange: (rows: FixedExpenseInput[]) => void
  periodDays: 7 | 14
  disabled?: boolean
  onEditingChange?: (editing: boolean) => void
  title?: string
  hint?: string
  allowMileage?: boolean
}

type Mode = 'idle' | 'add' | 'change' | 'end'
type Status = 'current' | 'scheduled' | 'ended'

const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em',
}
const input: React.CSSProperties = {
  height: 36, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px',
  fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', boxSizing: 'border-box',
}
const btnBase: React.CSSProperties = {
  height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ds-border)',
  background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12, fontWeight: 600,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
}
const primaryBtn: React.CSSProperties = { ...btnBase, border: 'none', background: 'var(--ds-blue)', color: '#fff' }
const dangerBtn: React.CSSProperties = { ...btnBase, border: 'none', background: 'var(--ds-red, #dc2626)', color: '#fff' }

const STATUS_STYLES: Record<Status, { color: string; background: string; label: string }> = {
  current: { color: '#15803d', background: '#dcfce7', label: 'current' },
  scheduled: { color: 'var(--ds-blue)', background: 'var(--ds-blue-soft, #eff6ff)', label: 'scheduled' },
  ended: { color: 'var(--ds-t3)', background: 'var(--ds-surface)', label: 'ended' },
}

/** A revision ended on a future date still charges until then, so it stays current. */
function statusOf(row: FixedExpenseInput, today: string): Status {
  if (row.until && row.until <= today) return 'ended'
  if (row.from && row.from > today) return 'scheduled'
  return 'current'
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function formatRate(n: number) {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: true })}`
}

function formatMiles(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: true })
}

/** Strip cosmetic characters; reject anything that isn't a plain positive decimal. */
function parseStrictPositive(s: string, maxDecimals?: number): number | null {
  const cleaned = s.replace(/[$,\s]/g, '')
  const decimals = maxDecimals == null ? '' : `{1,${maxDecimals}}`
  const pattern = maxDecimals == null ? /^\d+(\.\d+)?$/ : new RegExp(`^\\d+(\\.\\d${decimals})?$`)
  if (!pattern.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? n : null
}

function localToday() {
  return chicagoDateStr(new Date())
}

export function FixedExpenseEditor({
  value,
  onChange,
  periodDays,
  disabled,
  onEditingChange,
  title = `Fixed ${periodDays === 7 ? 'weekly' : 'biweekly'} expenses`,
  hint,
  allowMileage = false,
}: FixedExpenseEditorProps) {
  const { user } = useAuth()
  const today = localToday()
  const prepared = useMemo(() => prepareFixedExpenses(value ?? []), [value])
  const [mode, setMode] = useState<Mode>('idle')
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftAmount, setDraftAmount] = useState('')
  const [draftDate, setDraftDate] = useState(today)
  const [amountType, setAmountType] = useState<'fixed' | 'mileage'>('fixed')
  const [draftCostPerMile, setDraftCostPerMile] = useState('')
  const [draftMiles, setDraftMiles] = useState('')
  const [error, setError] = useState<string | null>(null)
  const formId = useId()

  useEffect(() => {
    onEditingChange?.(mode !== 'idle')
  }, [mode, onEditingChange])

  const selected = useMemo(
    () => prepared.find((r) => r.revisionId === selectedRevisionId) ?? null,
    [prepared, selectedRevisionId],
  )

  const reset = () => {
    setMode('idle')
    setSelectedRevisionId(null)
    setDraftLabel('')
    setDraftAmount('')
    setDraftDate(today)
    setAmountType('fixed')
    setDraftCostPerMile('')
    setDraftMiles('')
    setError(null)
  }

  const startAdd = () => {
    setMode('add')
    setSelectedRevisionId(null)
    setDraftLabel('')
    setDraftAmount('')
    setDraftDate(today)
    setAmountType('fixed')
    setDraftCostPerMile('')
    setDraftMiles('')
    setError(null)
  }

  const startChange = () => {
    setMode('change')
    setDraftLabel(selected?.label ?? '')
    const hasMileage = allowMileage && selected?.mileage != null
    setAmountType(hasMileage ? 'mileage' : 'fixed')
    setDraftAmount(hasMileage ? '' : (selected ? String(selected.amount) : ''))
    setDraftCostPerMile(hasMileage ? String(selected!.mileage!.costPerMile) : '')
    setDraftMiles(hasMileage ? String(selected!.mileage!.miles) : '')
    setDraftDate(today)
    setError(null)
  }

  const startEnd = () => {
    setMode('end')
    setDraftDate(today)
    setError(null)
  }

  const apply = () => {
    const labelText = draftLabel.trim()
    if ((mode === 'add' || mode === 'change') && !labelText) {
      setError('Expense type is required')
      return
    }
    if (!draftDate) { setError('Effective date is required'); return }
    if ((mode === 'change' || mode === 'end') && !selectedRevisionId) {
      setError('Select an expense to update')
      return
    }

    let amountNum: number | undefined
    let mileage: { costPerMile: number; miles: number } | undefined

    if ((mode === 'add' || mode === 'change') && amountType === 'mileage') {
      const costPerMile = parseStrictPositive(draftCostPerMile)
      const miles = parseStrictPositive(draftMiles, 3)
      if (costPerMile == null) { setError('Enter a valid cost per mile'); return }
      if (miles == null) { setError('Enter valid miles'); return }
      try {
        amountNum = calculateMileageExpense({ costPerMile, miles })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid mileage calculation')
        return
      }
      mileage = { costPerMile, miles }
    } else if (mode === 'add' || mode === 'change') {
      const parsedAmount = parseStrictPositive(draftAmount, 2)
      if (parsedAmount == null) { setError('Enter a positive amount'); return }
      amountNum = parsedAmount
    }

    const audit: FixedExpenseAudit = { at: new Date().toISOString(), by: user?.email ?? null }
    let change: FixedExpenseChange
    if (mode === 'add') {
      change = mileage
        ? { kind: 'add', label: labelText, amount: amountNum!, effectiveFrom: draftDate, mileage }
        : { kind: 'add', label: labelText, amount: amountNum!, effectiveFrom: draftDate }
    } else if (mode === 'change') {
      change = mileage
        ? {
            kind: 'change',
            revisionId: selectedRevisionId!,
            label: labelText,
            amount: amountNum!,
            effectiveFrom: draftDate,
            mileage,
          }
        : {
            kind: 'change',
            revisionId: selectedRevisionId!,
            label: labelText,
            amount: amountNum!,
            effectiveFrom: draftDate,
          }
    } else {
      change = { kind: 'end', revisionId: selectedRevisionId!, effectiveFrom: draftDate }
    }

    try {
      onChange(applyFixedExpenseChange(prepared, change, audit))
      reset()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, FixedExpenseInput[]>()
    for (const row of prepared) {
      const key = row.expenseId ?? row.revisionId ?? `legacy-${row.label}-${row.from}`
      const list = map.get(key) ?? []
      list.push(row)
      map.set(key, list)
    }
    return Array.from(map.entries()).map(([expenseId, rows]) => ({
      expenseId,
      rows: rows.sort((a, b) => (a.from ?? '').localeCompare(b.from ?? '')),
    }))
  }, [prepared])

  const periodLabel = periodDays === 7 ? 'week' : 'biweekly period'
  const defaultHint = `Deducted every ${periodLabel}. Fuel pulls from the card automatically — don't add it here. Ending an expense keeps history; changes create a new dated version.`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={label}>{title}</label>
        <button
          type="button"
          onClick={startAdd}
          disabled={disabled || mode !== 'idle'}
          style={{ ...primaryBtn, opacity: disabled || mode !== 'idle' ? 0.55 : 1 }}
        >
          <Plus size={13} /> Add expense type
        </button>
      </div>

      <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{hint ?? defaultHint}</div>

      {prepared.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ds-t3)' }}>No fixed expenses.</div>}

      {grouped.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {grouped.map(({ expenseId, rows }) => (
            <div
              key={expenseId}
              style={{
                border: '1px solid var(--ds-border)',
                borderRadius: 10,
                padding: '10px 12px',
                background: 'var(--ds-bg)',
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t3)', marginBottom: 6 }}>
                {rows[0]?.label ?? 'Unknown expense'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rows.map((row, idx) => {
                  const status = statusOf(row, today)
                  const styles = STATUS_STYLES[status]
                  return (
                    <label
                      key={row.revisionId ?? idx}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 8px', borderRadius: 6, cursor: mode === 'idle' ? 'pointer' : 'default',
                        background: status === 'current' ? 'var(--ds-surface)' : 'transparent',
                        border: '1px solid var(--ds-border)',
                      }}
                    >
                      {mode === 'idle' && status !== 'ended' && (
                        <input
                          type="radio"
                          name={`${formId}-revision`}
                          checked={selectedRevisionId === row.revisionId}
                          onChange={() => setSelectedRevisionId(row.revisionId ?? null)}
                          disabled={disabled}
                        />
                      )}
                      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ds-t1)' }}>
                        {row.mileage
                          ? `${formatMiles(row.mileage.miles)} miles × ${formatRate(row.mileage.costPerMile)}/mi = ${formatCurrency(row.amount)}`
                          : formatCurrency(row.amount)}
                        {' · '}
                        {row.from ?? 'start'} → {row.until ?? 'now'}
                      </span>
                      <span
                        style={{
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                          padding: '2px 6px', borderRadius: 4,
                          color: styles.color,
                          background: styles.background,
                        }}
                      >
                        {styles.label}
                      </span>
                    </label>
                  )
                })}
              </div>
              <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--ds-t3)' }}>
                {rows.map((row, idx) => (
                  <span key={idx}>
                    {idx > 0 && ' · '}
                    {row.from ?? 'start'} version recorded {row.recordedAt ? new Date(row.recordedAt).toLocaleString() : 'unknown'}
                    {row.recordedBy ? ` by ${row.recordedBy}` : ''}
                    {row.endedAt && row.until && (
                      <> · ended {new Date(row.endedAt).toLocaleString()}
                        {row.endedBy ? ` by ${row.endedBy}` : ''}
                      </>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {mode === 'idle' && selectedRevisionId && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={startChange} disabled={disabled} style={btnBase}>
            <PenLine size={13} /> Change
          </button>
          <button type="button" onClick={startEnd} disabled={disabled} style={dangerBtn}>
            <Ban size={13} /> End
          </button>
        </div>
      )}

      {mode !== 'idle' && (
        <div
          style={{
            border: '1px solid var(--ds-border)',
            borderRadius: 10,
            padding: 14,
            background: 'var(--ds-surface)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)' }}>
            {mode === 'add'
              ? 'Add new expense type'
              : mode === 'change'
                ? `Change ${selected?.label ?? ''}`
                : `End ${selected?.label ?? ''}`}
          </div>

          {(mode === 'add' || mode === 'change') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label htmlFor={`${formId}-label`} style={label}>Expense type *</label>
                  <input
                    id={`${formId}-label`}
                    style={input}
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder="Insurance"
                    disabled={disabled}
                  />
                </div>
                {amountType === 'fixed' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label htmlFor={`${formId}-amount`} style={label}>Amount *</label>
                    <input
                      id={`${formId}-amount`}
                      style={input}
                      value={draftAmount}
                      onChange={(e) => setDraftAmount(e.target.value)}
                      placeholder="250"
                      disabled={disabled}
                    />
                  </div>
                )}
              </div>

              {allowMileage && (
                <div>
                  <label style={label}>Calculation</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    {[
                      { v: 'fixed' as const, t: 'Fixed amount' },
                      { v: 'mileage' as const, t: 'Mileage calculation' },
                    ].map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => {
                          setAmountType(opt.v)
                          if (opt.v === 'fixed') {
                            setDraftCostPerMile('')
                            setDraftMiles('')
                          } else {
                            setDraftAmount('')
                          }
                          setError(null)
                        }}
                        disabled={disabled}
                        style={{
                          flex: 1, textAlign: 'left', padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                          border: `1.5px solid ${amountType === opt.v ? 'var(--ds-blue)' : 'var(--ds-border)'}`,
                          background: amountType === opt.v ? 'var(--ds-blue-soft, #eff6ff)' : 'var(--ds-surface)',
                          fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)',
                        }}
                      >
                        {opt.t}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {allowMileage && amountType === 'mileage' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 10 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label htmlFor={`${formId}-cost-per-mile`} style={label}>Cost per mile ($/mile) *</label>
                      <input
                        id={`${formId}-cost-per-mile`}
                        style={input}
                        value={draftCostPerMile}
                        onChange={(e) => setDraftCostPerMile(e.target.value)}
                        placeholder="0.125"
                        disabled={disabled}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label htmlFor={`${formId}-miles`} style={label}>Miles *</label>
                      <input
                        id={`${formId}-miles`}
                        style={input}
                        value={draftMiles}
                        onChange={(e) => setDraftMiles(e.target.value)}
                        placeholder="2000"
                        disabled={disabled}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label htmlFor={`${formId}-calculated-amount`} style={label}>Calculated amount</label>
                      <input
                        id={`${formId}-calculated-amount`}
                        style={{ ...input, background: 'var(--ds-bg)' }}
                        value={(() => {
                          const costPerMile = parseStrictPositive(draftCostPerMile)
                          const miles = parseStrictPositive(draftMiles, 3)
                          if (costPerMile == null || miles == null) return ''
                          try {
                            return formatCurrency(calculateMileageExpense({ costPerMile, miles }))
                          } catch {
                            return ''
                          }
                        })()}
                        readOnly
                        disabled={disabled}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>
                    Amount uses the miles you enter for this weekly expense. The existing effective-date and day proration still apply; this is not an automatic ELD download.
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor={`${formId}-date`} style={label}>
              {mode === 'end' ? 'End date *' : 'Effective from *'}
            </label>
            <input
              id={`${formId}-date`}
              type="date"
              style={{ ...input, maxWidth: 200 }}
              value={draftDate}
              onChange={(e) => setDraftDate(e.target.value)}
              disabled={disabled}
            />
            <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>
              {mode === 'end'
                ? 'The expense stops on this date; a partial period is prorated by day.'
                : 'The new amount/type starts on this date; a partial period is prorated by day.'}
            </div>
          </div>

          {error && <div style={{ fontSize: 12, color: '#dc2626' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={reset} disabled={disabled} style={btnBase}>
              <X size={13} /> Cancel
            </button>
            <button type="button" onClick={apply} disabled={disabled} style={primaryBtn}>
              <Check size={13} /> Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
