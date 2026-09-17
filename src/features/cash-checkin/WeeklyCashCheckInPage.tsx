import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  LabelList,
  Cell,
} from 'recharts'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'

import { useIsMobile } from '@/hooks/useIsMobile'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import {
  type CashCheckIn,
  type CashCheckInInput,
  type CashOutlookRow,
  type CashSettingsValues,
  type CenterKey,
  CENTERS,
  MAX_LAG_MONTHS,
  addCashMonths,
  cashDateLabel,
  cashMoney,
  cashMonthLabel,
  cashToday,
  clampLagMonths,
  factoringSummary,
  latestCashCheckIn,
  projectCash,
  trueLiquidity,
  validateCashCheckIn,
} from '@/lib/cashCheckIn'
import { useCashCheckIn, type UseCashCheckIn } from '@/hooks/useCashCheckIn'

// ── Shared token styles ──────────────────────────────────────────────────────

const CARD: React.CSSProperties = { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', overflow: 'hidden' }
const CARD_HEADER: React.CSSProperties = { padding: '16px 20px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const CARD_BODY: React.CSSProperties = { padding: '14px 20px 20px' }

const INPUT: React.CSSProperties = { width: 130, height: 30, padding: '0 8px', textAlign: 'right', borderRadius: 7, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t1)', fontSize: 13, fontVariantNumeric: 'tabular-nums', fontFamily: 'inherit', outline: 'none' }
const TEXT_INPUT: React.CSSProperties = { ...INPUT, textAlign: 'left' }
const DATE_INPUT: React.CSSProperties = { ...INPUT, textAlign: 'left', width: 148 }

const FIELD_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--ds-border)' }

const BTN_PRIMARY: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-blue)', background: 'var(--ds-blue)', color: '#fff', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }
const BTN_SECONDARY: React.CSSProperties = { ...BTN_PRIMARY, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)' }
const BTN_DANGER: React.CSSProperties = { ...BTN_PRIMARY, border: '1px solid var(--ds-red)', background: 'var(--ds-red)', color: '#fff' }
const BTN_ICON: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer' }

const PILL: React.CSSProperties = { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4, letterSpacing: '0.04em' }
const TH: React.CSSProperties = { padding: '9px 12px', fontSize: 11.5, fontWeight: 600, color: 'var(--ds-t3)', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--ds-border)' }
const TD: React.CSSProperties = { padding: '9px 12px', fontSize: 12.5, textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--ds-border)' }


// ── Formatting ───────────────────────────────────────────────────────────────

function cashK(n: number): string {
  const v = Math.round(n / 1000)
  const sign = v < 0 ? '\u2212' : ''
  return `${sign}$${Math.abs(v).toLocaleString('en-US')}K`
}

function signedMoney(n: number): string {
  const prefix = n >= 0 ? '+' : '\u2212'
  return `${prefix}${cashMoney(Math.abs(n))}`
}

function statusPill(status: CashOutlookRow['status']): { text: string; style: React.CSSProperties } {
  if (status === 'short') return { text: 'Short', style: { ...PILL, color: 'var(--ds-red)', background: 'var(--ds-red-bg)' } }
  if (status === 'low') return { text: 'Below floor', style: { ...PILL, color: 'var(--ds-amber)', background: 'var(--ds-amber-bg)' } }
  return { text: 'Covered', style: { ...PILL, color: 'var(--ds-green)', background: 'var(--ds-green-bg)' } }
}


// ── Controlled numeric draft input ───────────────────────────────────────────

type NumericInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | null | undefined
  onChange: (value: number | null) => void
  integer?: boolean
}

function NumericInput({ value, onChange, integer = false, ...props }: NumericInputProps) {
  const [draft, setDraft] = useState(() => formatDraft(value, integer))
  const focusedRef = useRef(false)
  const [blurTick, setBlurTick] = useState(0)

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(formatDraft(value, integer))
    }
  }, [value, integer, blurTick])

  return (
    <input
      {...props}
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      style={{ ...INPUT, ...props.style }}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw === '') {
          onChange(null)
          return
        }
        if (integer && /^-?\d*$/.test(raw)) {
          onChange(parseInteger(raw))
          return
        }
        if (!integer && /^-?\d*\.?\d*$/.test(raw)) {
          onChange(parseDecimal(raw))
          return
        }
      }}
      onFocus={(e) => {
        focusedRef.current = true
        props.onFocus?.(e)
      }}
      onBlur={(e) => {
        focusedRef.current = false
        onChange(integer ? parseInteger(e.target.value) : parseDecimal(e.target.value))
        setBlurTick((n) => n + 1)
        props.onBlur?.(e)
      }}
    />
  )
}

function formatDraft(value: number | null | undefined, integer: boolean): string {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  return integer ? String(Math.round(value)) : String(value)
}

function parseInteger(raw: string): number | null {
  if (raw === '' || raw === '-' || raw === '+') return null
  const n = Number(raw)
  if (Number.isNaN(n)) return null
  return Math.round(n)
}

function parseDecimal(raw: string): number | null {
  if (raw === '' || raw === '-' || raw === '+') return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}


// ── Controlled text draft input ──────────────────────────────────────────────

type TextDraftInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
  validate?: (value: string) => boolean
}

function TextDraftInput({ value, onChange, validate, ...props }: TextDraftInputProps) {
  const [draft, setDraft] = useState(value)
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value)
    }
  }, [value])

  return (
    <input
      {...props}
      type="text"
      style={{ ...TEXT_INPUT, ...props.style }}
      value={draft}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (!validate || validate(raw)) {
          onChange(raw)
        }
      }}
      onFocus={(e) => {
        focusedRef.current = true
        props.onFocus?.(e)
      }}
      onBlur={(e) => {
        focusedRef.current = false
        setDraft(value)
        props.onBlur?.(e)
      }}
    />
  )
}


function Banner({ tone, children }: { tone: 'warn' | 'error'; children: ReactNode }) {
  const color = tone === 'error' ? 'var(--ds-red)' : 'var(--ds-amber)'
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px', borderRadius: 10, border: `1px solid ${color}33`, background: `${color}0f` }}>
      <AlertTriangle size={15} style={{ color, flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12.5, color, lineHeight: 1.55 }}>{children}</div>
    </div>
  )
}

// ── Page / View ──────────────────────────────────────────────────────────────

export function WeeklyCashCheckInPage() {
  const data = useCashCheckIn()
  return <WeeklyCashCheckInView data={data} />
}

export function WeeklyCashCheckInView({ data }: { data: UseCashCheckIn }) {
  const isMobile = useIsMobile()
  const rows = useMemo(() => projectCash(data.checkins, data.settings), [data.checkins, data.settings])
  const latest = useMemo(() => latestCashCheckIn(data.checkins), [data.checkins])
  const [editingCheckIn, setEditingCheckIn] = useState<CashCheckIn | null>(null)
  const [formMessage, setFormMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <HeaderSection data={data} />
        {data.backendMissing && (
          <Banner tone="warn">
            The Weekly Cash Check-in tables aren't in the deployed backend yet, so nothing on this page will
            save. Everything below still calculates from the default assumptions — deploy the Amplify backend
            (the <code>CashCheckIn</code> and <code>CashSettings</code> models) to turn on saving.
          </Banner>
        )}
        {data.error && <Banner tone="error">{data.error}</Banner>}
        <SummaryStrip data={data} rows={rows} latest={latest} />
        <CheckInFormSection
          key={editingCheckIn?.id ?? 'new'}
          data={data}
          editingCheckIn={editingCheckIn}
          message={formMessage}
          onMessage={setFormMessage}
          onDoneEditing={() => setEditingCheckIn(null)}
        />
        <OutlookSection data={data} rows={rows} />
        <RunRateSection data={data} />
        <FactoringSection data={data} rows={rows} />
        <HistorySection data={data} onEdit={(row) => { setFormMessage(null); setEditingCheckIn(row) }} />
        <ExplanationNotes />
      </div>
    </div>
  )
}


// ── Header ───────────────────────────────────────────────────────────────────

function HeaderSection({ data }: { data: UseCashCheckIn }) {
  const { text, color } = useMemo(() => {
    if (data.backendMissing) return { text: 'Backend not ready · settings unavailable', color: 'var(--ds-amber)' }
    if (data.error) return { text: `Error: ${data.error}`, color: 'var(--ds-red)' }
    if (data.loading) return { text: 'Loading…', color: 'var(--ds-amber)' }
    if (data.saving || data.settingsSaving) return { text: 'Saving…', color: 'var(--ds-amber)' }
    if (!data.canWrite) return { text: 'Read-only · admin access required', color: 'var(--ds-amber)' }
    return { text: 'Saved · ready', color: 'var(--ds-green)' }
  }, [data.backendMissing, data.error, data.loading, data.saving, data.settingsSaving, data.canWrite])

  return (
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, paddingBottom: 16, borderBottom: '1px solid var(--ds-border)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>
          BCAT Corp · weekly review
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: '6px 0 0' }}>
          BCAT Weekly Cash Check-in
        </h1>
        <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 4, maxWidth: '42rem', lineHeight: 1.5 }}>
          Every Friday: log cash, receivables, payables, and each center's profit for the month so far. The
          configurable outlook re-bases from the latest check-in.
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ds-t3)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span>{text}</span>
      </div>
    </header>
  )
}


// ── Summary strip ────────────────────────────────────────────────────────────

function SummaryStrip({
  data,
  rows,
  latest,
}: {
  data: UseCashCheckIn
  rows: CashOutlookRow[]
  latest: CashCheckIn | null
}) {
  const prior = useMemo(() => {
    const sorted = [...data.checkins].sort((a, b) => b.date.localeCompare(a.date))
    return sorted[1] ?? null
  }, [data.checkins])

  const latestLiq = latest ? trueLiquidity(latest) : null
  const priorLiq = prior ? trueLiquidity(prior) : null
  const delta = latestLiq !== null && priorLiq !== null ? latestLiq - priorLiq : null

  const fixed = useMemo(
    () => CENTERS.reduce((sum, c) => sum + data.settings.runrate[c.key].fixed, 0),
    [data.settings.runrate]
  )
  const run = useMemo(
    () => CENTERS.reduce((sum, c) => sum + data.settings.runrate[c.key].profit, 0),
    [data.settings.runrate]
  )

  const end = rows[rows.length - 1]
  const low = useMemo(() => rows.reduce((min, r) => (r.cash < min.cash ? r : min), rows[0]), [rows])

  const cash = latest ? latest.cash : null
  const cards = latest?.cards ?? null

  const coverageWeeks = fixed > 0 && cash !== null ? (cash / fixed) * 4.33 : null

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      <SummaryTile
        label={latest ? `Cash on hand · ${cashDateLabel(latest.date)}` : 'Cash on hand'}
        value={cash !== null ? cashMoney(cash) : '—'}
        valueColor={cash !== null ? (cash < 0 ? 'red' : cash > 0 ? 'green' : undefined) : undefined}
        sub={
          cash !== null
            ? fixed > 0
              ? `${cards ? cashMoney(cards) + ' on cards · ' : ''}covers ${coverageWeeks?.toFixed(1) ?? '—'} weeks of fixed expenses`
              : `${cards ? cashMoney(cards) + ' on cards · ' : ''}no fixed expenses to cover`
            : 'log your first check-in'
        }
      />
      <SummaryTile
        label="True liquidity"
        value={latestLiq !== null ? cashMoney(latestLiq) : '—'}
        valueColor={latestLiq !== null ? (latestLiq < 0 ? 'red' : latestLiq > 0 ? 'green' : undefined) : undefined}
        sub={
          !latest || latestLiq === null
            ? 'cash − cards + AR − AP'
            : delta !== null
              ? `${signedMoney(delta)} vs prior check-in`
              : `${cashMoney(latest.ar ?? 0)} AR − ${cashMoney(latest.ap ?? 0)} AP`
        }
      />
      <SummaryTile
        label="Run-rate group net / month"
        value={cashMoney(run)}
        valueColor={run < 0 ? 'red' : run > 0 ? 'green' : undefined}
        sub={CENTERS.map((c) => `${c.name.split(' ')[0]} ${cashK(data.settings.runrate[c.key].profit)}`).join(' · ')}
      />
      <SummaryTile
        label={end ? `Cash in ${cashMonthLabel(end.ym)}` : 'Cash outlook'}
        value={end ? cashMoney(end.cash) : '—'}
        valueColor={end ? (end.cash < 0 ? 'red' : end.cash > 0 ? 'green' : undefined) : undefined}
        sub={
          end
            ? low.cash < data.settings.floor
              ? `dips to ${cashMoney(low.cash)} in ${cashMonthLabel(low.ym)}`
              : `lowest point ${cashMoney(low.cash)} · above floor`
            : '—'
        }
      />
    </div>
  )
}

function SummaryTile({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string
  value: ReactNode
  sub: ReactNode
  valueColor?: 'green' | 'red'
}) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '14px 16px', boxShadow: 'var(--sh-sm)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em', color: valueColor === 'green' ? 'var(--ds-green)' : valueColor === 'red' ? 'var(--ds-red)' : 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ marginTop: 3, fontSize: 12, color: 'var(--ds-t3)' }}>{sub}</div>
    </div>
  )
}


// ── Check-in form ────────────────────────────────────────────────────────────

function emptyForm(): CheckInFormState {
  return {
    date: cashToday(),
    cash: null,
    ar: null,
    ap: null,
    cards: null,
    bcatMtd: null,
    ivanMtd: null,
    amazonMtd: null,
    note: '',
    editingId: null,
  }
}

interface CheckInFormState {
  date: string
  cash: number | null
  ar: number | null
  ap: number | null
  cards: number | null
  bcatMtd: number | null
  ivanMtd: number | null
  amazonMtd: number | null
  note: string
  editingId: string | null
}

function formFromEditing(editing: CashCheckIn | null): CheckInFormState {
  if (!editing) return emptyForm()
  return {
    date: editing.date,
    cash: editing.cash,
    ar: editing.ar ?? null,
    ap: editing.ap ?? null,
    cards: editing.cards ?? null,
    bcatMtd: editing.bcatMtdProfit ?? null,
    ivanMtd: editing.ivanMtdProfit ?? null,
    amazonMtd: editing.amazonMtdProfit ?? null,
    note: editing.note ?? '',
    editingId: editing.id,
  }
}

function CheckInFormSection({
  data,
  editingCheckIn,
  message,
  onMessage,
  onDoneEditing,
}: {
  data: UseCashCheckIn
  editingCheckIn: CashCheckIn | null
  message: { text: string; tone: 'success' | 'error' } | null
  onMessage: (message: { text: string; tone: 'success' | 'error' } | null) => void
  onDoneEditing: () => void
}) {
  const [form, setForm] = useState<CheckInFormState>(() => formFromEditing(editingCheckIn))
  const [note, setNote] = useState(() => editingCheckIn?.note ?? '')

  const isEditing = form.editingId !== null

  const reset = useCallback(() => {
    setForm(emptyForm())
    setNote('')
    onDoneEditing()
  }, [onDoneEditing])

  const cancelEdit = useCallback(() => {
    onMessage(null)
    reset()
  }, [onMessage, reset])

  const update = useCallback(<K extends keyof CheckInFormState>(key: K, value: CheckInFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSave = async () => {
    onMessage(null)
    if (form.cash === null) { onMessage({ text: 'Cash on hand is required.', tone: 'error' }); return }
    const input: CashCheckInInput = {
      date: form.date,
      cash: form.cash,
      ar: form.ar,
      ap: form.ap,
      cards: form.cards,
      bcatMtdProfit: form.bcatMtd,
      ivanMtdProfit: form.ivanMtd,
      amazonMtdProfit: form.amazonMtd,
      note: note.trim() || null,
    }
    try {
      validateCashCheckIn(input)
      await data.saveCheckIn(input, form.editingId ?? undefined)
      onMessage({ text: `Saved ${cashDateLabel(input.date)}. Outlook re-based.`, tone: 'success' })
      reset()
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Could not save check-in.'
      onMessage({ text, tone: 'error' })
    }
  }

  const disabled = !data.canWrite || data.saving

  return (
    <section>
      <SectionHeader
        title="This week's check-in"
        subtitle="Whole dollars. Profit fields are month-to-date for the month the check-in date falls in; the outlook scales them to a full month."
      />
      <div style={CARD}>
        <div style={CARD_BODY}>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Field label="Check-in date" htmlFor="ci-date">
              <input
                id="ci-date"
                type="date"
                value={form.date}
                onChange={(e) => update('date', e.target.value)}
                disabled={disabled}
                style={DATE_INPUT}
              />
            </Field>
            <Field label="Cash on hand (all accounts)" hint="Bank balance at close">
              <NumericInput value={form.cash} onChange={(v) => update('cash', v)} integer placeholder="0" disabled={disabled} />
            </Field>
            <Field label="Receivables outstanding" hint="AR report grand total">
              <NumericInput value={form.ar} onChange={(v) => update('ar', v)} integer placeholder="0" disabled={disabled} />
            </Field>
            <Field label="Payables outstanding" hint="Cash Requirements grand total">
              <NumericInput value={form.ap} onChange={(v) => update('ap', v)} integer placeholder="0" disabled={disabled} />
            </Field>
          </div>

          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ds-border)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)' }}>Profit this month so far</h3>
              <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>revenue − all expenses, month-to-date</span>
            </div>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {CENTERS.map((c) => (
                <Field key={c.key} label={c.name}>
                  <NumericInput
                    value={form[`${c.key}Mtd` as keyof CheckInFormState] as number | null}
                    onChange={(v) => update(`${c.key}Mtd` as keyof CheckInFormState, v)}
                    integer
                    placeholder="0"
                    disabled={disabled}
                  />
                </Field>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ds-border)' }}>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Field label="Note" htmlFor="ci-note">
                <TextDraftInput
                  id="ci-note"
                  type="text"
                  value={note}
                  onChange={(v) => setNote(v)}
                  placeholder="what moved this week"
                  disabled={disabled}
                  style={{ ...TEXT_INPUT, flex: '1 1 0', minWidth: 0 }}
                />
              </Field>
              <Field label="Credit cards owed">
                <NumericInput value={form.cards} onChange={(v) => update('cards', v)} integer placeholder="0" disabled={disabled} />
              </Field>
            </div>
          </div>

          <div style={{ marginTop: 18, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <button
              onClick={handleSave}
              disabled={disabled || form.cash === null || !form.date}
              style={{ ...BTN_PRIMARY, cursor: disabled || form.cash === null || !form.date ? 'default' : 'pointer', opacity: disabled || form.cash === null || !form.date ? 0.7 : 1 }}
            >
              {data.saving ? (
                <>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Saving…
                </>
              ) : isEditing ? (
                'Update check-in'
              ) : (
                'Save check-in'
              )}
            </button>
            {isEditing && (
              <button onClick={cancelEdit} disabled={disabled} style={BTN_SECONDARY}>
                Cancel edit
              </button>
            )}
            {message && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: message.tone === 'success' ? 'var(--ds-green)' : 'var(--ds-red)' }}>
                {message.tone === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                {message.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}


// ── Outlook: chart + table ───────────────────────────────────────────────────

function OutlookSection({ data, rows }: { data: UseCashCheckIn; rows: CashOutlookRow[] }) {
  const showFx = data.settings.factoring.on && rows.some((r) => r.fxCash !== undefined)

  return (
    <section>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <SectionHeader title="Cash outlook" />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, fontSize: 12, color: 'var(--ds-t3)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ds-amber)' }} /> Logged
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ds-blue)' }} /> Projected
          </span>
          {showFx && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 16, height: 0, borderTop: '2px dashed var(--ds-t1)' }} /> With factoring
            </span>
          )}
        </div>
      </div>

      <div style={{ ...CARD, padding: 12 }}>
        <div style={{ minWidth: Math.max(640, rows.length * 70 + 140), height: 320 }}>
          <OutlookChart data={data} rows={rows} />
        </div>
      </div>

      <div style={{ marginTop: 12, ...CARD }}>
        <div style={{ overflowX: 'auto' }}>
          <OutlookTable rows={rows} showFx={showFx} />
        </div>
      </div>
    </section>
  )
}

function OutlookChart({ data, rows }: { data: UseCashCheckIn; rows: CashOutlookRow[] }) {
  const hist = useMemo(() => {
    const sorted = [...data.checkins].sort((a, b) => a.date.localeCompare(b.date)).slice(-8)
    return sorted.map((h) => ({
      name: cashDateLabel(h.date),
      cash: h.cash,
      fxCash: null as number | null,
      hist: true,
    }))
  }, [data.checkins])

  const proj = useMemo(() => {
    const start = hist.length === 0 && rows.length > 0 ? rows : rows.slice(1)
    return start.map((r) => ({
      name: cashMonthLabel(r.ym),
      cash: r.cash,
      fxCash: r.fxCash ?? null,
      hist: false,
    }))
  }, [hist.length, rows])

  const bars = useMemo(() => [...hist, ...proj], [hist, proj])

  const yDomain = useMemo(() => {
    const vals = bars.flatMap((b) => [b.cash, b.fxCash ?? b.cash, data.settings.floor, 0])
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const pad = (max - min) * 0.12 || 10000
    return [Math.min(0, min - pad), max + pad] as [number, number]
  }, [bars, data.settings.floor])

  if (bars.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ds-t3)' }}>
        Save a check-in to build the outlook chart.
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={bars} margin={{ top: 24, right: 16, bottom: 48, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--ds-border)" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 11, fill: 'var(--ds-t3)' }}
          axisLine={{ stroke: 'var(--ds-border)' }}
          tickLine={false}
          angle={-45}
          textAnchor="end"
          height={60}
          interval={0}
        />
        <YAxis
          tickFormatter={(v: number) => cashK(v)}
          tick={{ fontSize: 11, fill: 'var(--ds-t3)' }}
          axisLine={false}
          tickLine={false}
          domain={yDomain}
        />
        <RechartsTooltip
          formatter={(value, name) => [typeof value === 'number' ? cashMoney(value) : String(value ?? ''), String(name ?? '')]}
          labelStyle={{ color: 'var(--ds-t1)' }}
          contentStyle={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 8, fontSize: 12 }}
        />
        <ReferenceLine
          y={data.settings.floor}
          stroke="var(--ds-amber)"
          strokeDasharray="4 4"
          label={{ value: 'floor', position: 'insideTopLeft', fill: 'var(--ds-amber)', fontSize: 11 }}
        />
        <Bar dataKey="cash" isAnimationActive={false}>
          <LabelList dataKey="cash" position="top" formatter={(v) => (typeof v === 'number' ? cashK(v) : '')} fontSize={11} />
          {bars.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.hist ? 'var(--ds-amber)' : 'var(--ds-blue)'} />
          ))}
        </Bar>
        {data.settings.factoring.on && (
          <Line
            type="monotone"
            dataKey="fxCash"
            stroke="var(--ds-t1)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 3.5, stroke: 'var(--ds-surface)', strokeWidth: 2 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function OutlookTable({ rows, showFx }: { rows: CashOutlookRow[]; showFx: boolean }) {
  return (
    <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ ...TH, textAlign: 'left' }}>Month</th>
          {CENTERS.map((c) => (
            <th key={c.key} style={TH}>{c.name.split(' ')[0]}</th>
          ))}
          <th style={TH}>Earned</th>
          <th style={TH}>Lands in bank</th>
          <th style={TH}>Other items</th>
          <th style={TH}>Cash on hand</th>
          {showFx && <th style={TH}>With factoring</th>}
          <th style={{ ...TH, textAlign: 'left' }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pill = statusPill(r.status)
          const rowBg = r.current ? { background: 'var(--ds-green-bg)' } : undefined
          return (
            <tr key={r.ym} style={rowBg}>
              <td style={{ ...TD, textAlign: 'left', fontWeight: 600 }}>{cashMonthLabel(r.ym)}</td>
              {CENTERS.map((c) => (
                <td key={c.key} style={{ ...TD, color: r.per[c.key] < 0 ? 'var(--ds-red)' : r.per[c.key] > 0 ? 'var(--ds-green)' : 'var(--ds-t1)' }}>
                  {cashMoney(r.per[c.key])}
                  {r.current && r.estimated[c.key] && (
                    <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--ds-t3)' }}>est</span>
                  )}
                </td>
              ))}
              <td style={{ ...TD, fontWeight: 600 }}>{cashMoney(r.net)}</td>
              <td style={{ ...TD, fontWeight: 600 }}>
                {cashMoney(r.landing)}
                {r.current && (
                  <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{cashMoney(r.netToCome)} still to come</div>
                )}
              </td>
              <td style={TD}>
                {r.items.length > 0 ? (
                  <div>
                    <div style={{ color: r.itemsSum < 0 ? 'var(--ds-red)' : r.itemsSum > 0 ? 'var(--ds-green)' : 'var(--ds-t1)' }}>
                      {cashMoney(r.itemsSum)}
                    </div>
                    <div style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--ds-t3)' }}>
                      {r.items.map((i) => i.label || 'item').join(', ')}
                    </div>
                  </div>
                ) : (
                  '—'
                )}
              </td>
              <td style={{ ...TD, fontWeight: 700 }}>
                <span style={{ color: r.cash < 0 ? 'var(--ds-red)' : 'var(--ds-green)' }}>
                  {cashMoney(r.cash)}
                </span>
              </td>
              {showFx && (
                <td style={{ ...TD, fontWeight: 700 }}>
                  {cashMoney(r.fxCash ?? r.cash)}
                  {r.fxDelta ? (
                    <div style={{ fontSize: 11, color: 'var(--ds-t3)' }}>
                      {`${r.fxDelta >= 0 ? '+' : ''}${cashK(r.fxDelta)}`}
                      {r.fxActive ? ' · fee in' : ''}
                    </div>
                  ) : null}
                </td>
              )}
              <td style={{ ...TD, textAlign: 'left' }}>
                <span style={{ ...pill.style }}>{pill.text}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}


// ── Run-rate assumptions ─────────────────────────────────────────────────────

function RunRateSection({ data }: { data: UseCashCheckIn }) {
  return (
    <section>
      <SectionHeader
        title="Run-rate assumptions"
        subtitle="Used for every month after the current one. Fixed expenses are what goes out even in a slow month; profit is what each center nets in a normal one."
      />

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {CENTERS.map((c) => (
          <RunRateCard key={c.key} data={data} center={c} />
        ))}
      </div>

      <div style={{ marginTop: 16, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <GuardrailsCard data={data} />
        <OneTimeItemsCard data={data} />
      </div>
    </section>
  )
}

function RunRateCard({ data, center }: { data: UseCashCheckIn; center: (typeof CENTERS)[number] }) {
  const r = data.settings.runrate[center.key]
  const breakEven = r.fixed - Math.min(r.profit, 0)
  const disabled = !data.canWrite

  const patch = (field: 'fixed' | 'profit' | 'lagMonths', value: number | null) => {
    data.updateSettings({
      ...data.settings,
      runrate: {
        ...data.settings.runrate,
        [center.key]: { ...r, [field]: value ?? 0 },
      },
    })
  }

  return (
    <div style={CARD}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ds-border)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>{center.name}</h3>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>{center.tag}</span>
      </div>
      <div style={CARD_BODY}>
        <Field label="Fixed expenses / month">
          <NumericInput value={r.fixed} onChange={(v) => patch('fixed', v)} integer disabled={disabled} />
        </Field>
        <Field label="Run-rate profit / month">
          <NumericInput value={r.profit} onChange={(v) => patch('profit', v)} integer disabled={disabled} />
        </Field>
        <Field label="Cash lag (months)" hint="How long after profit is earned it lands in the bank. 30-day terms = 1.">
          <NumericInput value={r.lagMonths} onChange={(v) => patch('lagMonths', clampLagMonths(v ?? 0))} integer min={0} max={MAX_LAG_MONTHS} disabled={disabled} />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0 0', marginTop: 12, borderTop: '1px solid var(--ds-border)' }}>
          <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Break-even revenue</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums' }}>{cashMoney(breakEven)}</span>
        </div>
      </div>
    </div>
  )
}

function GuardrailsCard({ data }: { data: UseCashCheckIn }) {
  const disabled = !data.canWrite
  const patchFloor = (v: number | null) => {
    data.updateSettings({ ...data.settings, floor: v ?? 0 })
  }
  const patchMonths = (v: number | null) => {
    const months = Math.max(3, Math.min(12, v ?? 6))
    data.updateSettings({ ...data.settings, months })
  }
  const patchReminder = (patch: Partial<{ payrollAnchor: string; slackChannel: string }>) => {
    data.updateSettings({
      ...data.settings,
      reminder: { ...(data.settings.reminder ?? {}), ...patch },
    })
  }

  return (
    <div style={CARD}>
      <div style={{ ...CARD_HEADER, borderBottom: '1px solid var(--ds-border)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>Guardrails</span>
      </div>
      <div style={CARD_BODY}>
        <Field label="Cash floor to hold">
          <NumericInput value={data.settings.floor} onChange={patchFloor} integer disabled={disabled} />
        </Field>
        <Field label="Months in outlook">
          <NumericInput value={data.settings.months} onChange={patchMonths} integer min={3} max={12} disabled={disabled} />
        </Field>
        <Field label="Last payroll date" htmlFor="gr-payroll">
          <input
            id="gr-payroll"
            type="date"
            value={(data.settings.reminder?.payrollAnchor ?? '').slice(0, 10)}
            onChange={(e) => patchReminder({ payrollAnchor: e.target.value })}
            disabled={disabled}
            style={DATE_INPUT}
          />
        </Field>
        <Field label="Slack channel for the reminder" htmlFor="gr-slack">
          <TextDraftInput
            id="gr-slack"
            type="text"
            value={data.settings.reminder?.slackChannel ?? ''}
            onChange={(v) => patchReminder({ slackChannel: v.trim() })}
            placeholder="C0123ABCDEF"
            disabled={disabled}
            style={{ ...TEXT_INPUT, width: '100%' }}
          />
        </Field>
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
          Below the floor shows as a warning; below zero as short.
        </p>
        <p style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
          Every 14 days from the last payroll, the morning after, a Slack reminder asks for a check-in — unless one dated on or after that payroll is already logged.
        </p>
      </div>
    </div>
  )
}

function OneTimeItemsCard({ data }: { data: UseCashCheckIn }) {
  const disabled = !data.canWrite

  const updateItem = (index: number, field: keyof CashSettingsValues['items'][number], value: unknown) => {
    const next = data.settings.items.map((it, i) => (i === index ? { ...it, [field]: value } : it))
    data.updateSettings({ ...data.settings, items: next })
  }

  const addItem = () => {
    const nextMonth = addCashMonths(cashToday().slice(0, 7), 1)
    data.updateSettings({
      ...data.settings,
      items: [...data.settings.items, { ym: nextMonth, label: '', amount: 0 }],
    })
  }

  const removeItem = (index: number) => {
    const next = data.settings.items.filter((_, i) => i !== index)
    data.updateSettings({ ...data.settings, items: next })
  }

  return (
    <div style={CARD}>
      <div style={{ ...CARD_HEADER, borderBottom: '1px solid var(--ds-border)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>One-time items</span>
      </div>
      <div style={CARD_BODY}>
        <p style={{ fontSize: 12, color: 'var(--ds-t3)', marginBottom: 12, lineHeight: 1.5 }}>
          Cash that lands in a specific month outside the run-rate: paying off the cards, a hire's first month, a
          truck payment, tax deposit, Danisco reprice kicking in. Positive = in, negative = out.
        </p>

        {data.settings.items.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ds-t3)' }}>None yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.settings.items.map((it, i) => (
              <div key={i} style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(96px, 120px) minmax(0, 1fr) minmax(96px, 130px) auto', alignItems: 'end' }}>
                <StackedField label="Month">
                  <TextDraftInput value={it.ym} onChange={(v) => updateItem(i, 'ym', v)} validate={(v) => /^\d{4}-\d{2}$/.test(v)} placeholder="2026-10" disabled={disabled} style={{ ...TEXT_INPUT, width: '100%' }} />
                </StackedField>
                <StackedField label="What">
                  <TextDraftInput value={it.label} onChange={(v) => updateItem(i, 'label', v)} placeholder="e.g. new hire month 1" disabled={disabled} style={{ ...TEXT_INPUT, width: '100%', minWidth: 0 }} />
                </StackedField>
                <StackedField label="Amount">
                  <NumericInput value={it.amount} onChange={(v) => updateItem(i, 'amount', v ?? 0)} integer disabled={disabled} style={{ width: '100%' }} />
                </StackedField>
                <button onClick={() => removeItem(i)} disabled={disabled} style={BTN_SECONDARY} aria-label={`Remove ${it.label || 'item'}`}>
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <button onClick={addItem} disabled={disabled} style={{ ...BTN_SECONDARY, marginTop: 12 }}>
          <Plus size={14} /> Add item
        </button>
      </div>
    </div>
  )
}


// ── Factoring scenario ───────────────────────────────────────────────────────

function Toggle({ id, checked, onChange, disabled }: { id?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      id={id}
      style={{
        position: 'relative',
        width: 40,
        height: 22,
        borderRadius: 11,
        border: '1px solid ' + (checked ? 'var(--ds-blue)' : 'var(--ds-border)'),
        background: checked ? 'var(--ds-blue)' : 'var(--ds-surface)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 0.15s, border-color 0.15s',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: 1,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(15,23,42,0.15)',
          transform: checked ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 0.15s',
        }}
      />
    </button>
  )
}

function FactoringSection({ data, rows }: { data: UseCashCheckIn; rows: CashOutlookRow[] }) {
  const disabled = !data.canWrite
  const f = data.settings.factoring
  const summary = useMemo(() => factoringSummary(rows, data.settings), [rows, data.settings])

  const patchFactoring = (patch: Partial<CashSettingsValues['factoring']>) => {
    data.updateSettings({
      ...data.settings,
      factoring: { ...f, ...patch },
    })
  }

  return (
    <section>
      <SectionHeader
        title="Factoring scenario"
        subtitle="Model a go-forward facility on the customers you can factor. The outlook shows both lines so you can see the step-up, the monthly fee, and what happens when you stop."
      />

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div style={CARD}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>Facility</span>
          </div>
          <div style={CARD_BODY}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--ds-border)' }}>
              <label htmlFor="fx-on" style={{ fontSize: 13, color: 'var(--ds-t2)' }}>Include in outlook</label>
              <Toggle id="fx-on" checked={f.on} onChange={(checked) => patchFactoring({ on: checked })} disabled={disabled} />
            </div>
            <Field label="Start month">
              <TextDraftInput value={f.start} onChange={(v) => patchFactoring({ start: v })} validate={(v) => /^\d{4}-\d{2}$/.test(v)} placeholder="2026-10" disabled={disabled} />
            </Field>
            <Field label="Stop month (optional)">
              <TextDraftInput value={f.stop} onChange={(v) => patchFactoring({ stop: v })} validate={(v) => v === '' || /^\d{4}-\d{2}$/.test(v)} placeholder="leave blank" disabled={disabled} />
            </Field>
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
              Go-forward only: existing receivables collect on their own schedule.
            </p>
          </div>
        </div>

        <div style={CARD}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>Terms</span>
          </div>
          <div style={CARD_BODY}>
            <Field label="Eligible invoicing / month">
              <NumericInput value={f.eligible} onChange={(v) => patchFactoring({ eligible: v ?? 0 })} integer step={5000} disabled={disabled} />
            </Field>
            <Field label="Fee %" hint="quarter increments">
              <NumericInput value={f.fee} onChange={(v) => patchFactoring({ fee: v ?? 0 })} step={0.25} min={0} disabled={disabled} />
            </Field>
            <Field label="Advance %" hint="50 – 100">
              <NumericInput value={f.advance} onChange={(v) => patchFactoring({ advance: Math.max(50, Math.min(100, v ?? 90)) })} integer step={5} min={50} max={100} disabled={disabled} />
            </Field>
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ds-t3)', lineHeight: 1.5 }}>
              Eligible = revenue from customers you're allowed to factor (everyone except Danisco, Royal, Batory, Denali).
            </p>
          </div>
        </div>

        <div style={CARD}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ds-border)' }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>What it does</span>
          </div>
          <div style={CARD_BODY}>
            {f.on ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--ds-t1)' }}>
                <div>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{cashMoney(summary.stepUp)}</span> one-time step-up
                </div>
                <div>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{cashMoney(summary.advanceAmount)}</span> advance in the start month
                </div>
                <div>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--ds-red)' }}>{cashMoney(summary.monthlyFee)}</span> / month in fees
                </div>
                <div>
                  Ends at <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{cashMoney(summary.endCash)}</span> vs {cashMoney(summary.baseEndCash)} without · fees paid {cashMoney(summary.totalFees)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
                  {summary.stopReadyMonth ? (
                    <>
                      Could stop from <b>{cashMonthLabel(summary.stopReadyMonth)}</b>: cash minus the step-up reversal still clears the cushion.
                    </>
                  ) : (
                    'Not yet at a point where stopping keeps you above the cushion.'
                  )}
                </div>
              </div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--ds-t3)' }}>Turn on "Include in outlook" to see the comparison.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}


// ── History ──────────────────────────────────────────────────────────────────

function HistorySection({
  data,
  onEdit,
}: {
  data: UseCashCheckIn
  onEdit: (row: CashCheckIn) => void
}) {
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const sorted = useMemo(
    () => [...data.checkins].sort((a, b) => b.date.localeCompare(a.date)),
    [data.checkins]
  )

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportMessage(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      let raw: unknown[]
      if (Array.isArray(parsed)) {
        raw = parsed
      } else if (parsed && typeof parsed === 'object' && 'checkins' in parsed && Array.isArray(parsed.checkins)) {
        raw = parsed.checkins
      } else {
        throw new Error('JSON must be an array of check-ins or an object with a checkins array.')
      }

      const valid: CashCheckInInput[] = []
      const errors: string[] = []
      raw.forEach((row, idx) => {
        try {
          validateCashCheckIn(row)
          valid.push(row as CashCheckInInput)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'invalid'
          errors.push(`Row ${idx + 1}: ${msg}`)
        }
      })

      if (valid.length === 0) {
        setImportMessage({
          text: `No valid rows. ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
          tone: 'error',
        })
        return
      }

      const result = await data.importCheckIns(valid)
      setImportMessage({
        text: `Imported ${result.imported}, skipped ${result.skipped}.${errors.length > 0 ? ` ${errors.length} row error${errors.length === 1 ? '' : 's'}.` : ''}`,
        tone: 'success',
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Import failed.'
      setImportMessage({ text, tone: 'error' })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <section>
      <SectionHeader
        title="Check-in history"
        subtitle="True liquidity = cash − cards + receivables − payables. Watch it week over week: it should climb about as fast as group profit."
        right={
          data.canWrite && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFile}
                style={{ display: 'none' }}
              />
              <button onClick={() => fileRef.current?.click()} disabled={data.saving} style={BTN_SECONDARY}>
                <Upload size={14} /> Import JSON
              </button>
            </>
          )
        }
      />

      {importMessage && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13,
          border: `1px solid ${importMessage.tone === 'success' ? 'var(--ds-green)' : 'var(--ds-red)'}33`,
          background: `${importMessage.tone === 'success' ? 'var(--ds-green)' : 'var(--ds-red)'}0f`,
          color: importMessage.tone === 'success' ? 'var(--ds-green)' : 'var(--ds-red)',
        }}>
          {importMessage.tone === 'success' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {importMessage.text}
        </div>
      )}

      <div style={CARD}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...TH, textAlign: 'left' }}>Date</th>
                <th style={TH}>Cash</th>
                <th style={TH}>AR</th>
                <th style={TH}>AP</th>
                <th style={TH}>Cards</th>
                <th style={TH}>True liquidity</th>
                {CENTERS.map((c) => (
                  <th key={c.key} style={TH}>{c.name.split(' ')[0]} MTD</th>
                ))}
                <th style={{ ...TH, textAlign: 'left' }}>Note</th>
                {data.canWrite && <th style={{ ...TH, textAlign: 'left' }} aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={data.canWrite ? 11 : 10} style={{ ...TD, textAlign: 'left', color: 'var(--ds-t3)' }}>
                    No check-ins yet. Fill in the form above and save.
                  </td>
                </tr>
              ) : (
                sorted.map((h) => <HistoryRow key={h.id} data={data} row={h} onEdit={onEdit} onDelete={setDeleteId} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      <DeleteDialog
        open={deleteId !== null}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={async () => {
          if (!deleteId) return
          await data.deleteCheckIn(deleteId)
          setDeleteId(null)
        }}
        saving={data.saving}
      />
    </section>
  )
}

function HistoryRow({
  data,
  row,
  onEdit,
  onDelete,
}: {
  data: UseCashCheckIn
  row: CashCheckIn
  onEdit: (row: CashCheckIn) => void
  onDelete: (id: string) => void
}) {
  const liq = trueLiquidity(row)
  return (
    <tr>
      <td style={{ ...TD, textAlign: 'left', fontWeight: 600 }}>{cashDateLabel(row.date)}</td>
      <td style={TD}>{cashMoney(row.cash)}</td>
      <td style={TD}>{row.ar != null ? cashMoney(row.ar) : '—'}</td>
      <td style={TD}>{row.ap != null ? cashMoney(row.ap) : '—'}</td>
      <td style={TD}>{row.cards != null ? cashMoney(row.cards) : '—'}</td>
      <td style={{ ...TD, fontWeight: 600, color: liq < 0 ? 'var(--ds-red)' : 'var(--ds-green)' }}>
        {cashMoney(liq)}
      </td>
      {CENTERS.map((c) => (
        <td key={c.key} style={TD}>
          {mtdFor(row, c.key) != null ? cashMoney(mtdFor(row, c.key)!) : '—'}
        </td>
      ))}
      <td style={{ ...TD, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', color: 'var(--ds-t3)' }}>
        {row.note || '—'}
      </td>
      {data.canWrite && (
        <td style={{ ...TD, textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => onEdit(row)} disabled={data.saving} style={BTN_ICON} title="Edit">
              <Pencil size={13} />
            </button>
            <button onClick={() => onDelete(row.id)} disabled={data.saving} style={{ ...BTN_ICON, color: 'var(--ds-red)' }} title="Delete">
              <Trash2 size={13} />
            </button>
          </div>
        </td>
      )}
    </tr>
  )
}

function mtdFor(row: CashCheckIn, key: CenterKey): number | null | undefined {
  if (key === 'bcat') return row.bcatMtdProfit
  if (key === 'ivan') return row.ivanMtdProfit
  return row.amazonMtdProfit
}

function DeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
  saving: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 20 }}>
        <DialogHeader>
          <DialogTitle style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)' }}>Delete check-in?</DialogTitle>
          <DialogDescription style={{ fontSize: 13, color: 'var(--ds-t3)', lineHeight: 1.5, marginTop: 4 }}>
            This cannot be undone. The outlook will re-base from the remaining history.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => onOpenChange(false)} disabled={saving} style={BTN_SECONDARY}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={saving} style={BTN_DANGER}>
            {saving ? <Loader2 size={14} /> : <Trash2 size={14} />}
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


// ── Shared helpers ───────────────────────────────────────────────────────────

function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginTop: 8, marginBottom: 12 }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)', margin: 0, whiteSpace: 'nowrap' }}>
            {title}
          </h2>
          <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
        </div>
        {subtitle && <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 4, maxWidth: '48rem', lineHeight: 1.5 }}>{subtitle}</p>}
      </div>
      {right && <div>{right}</div>}
    </div>
  )
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label?: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <label htmlFor={htmlFor} style={FIELD_ROW}>
      <span style={{ fontSize: 13, color: 'var(--ds-t2)' }}>
        {label}
        {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--ds-t3)', marginTop: 1 }}>{hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** Label above the control — for dense rows (one-time items) where the side-by-side Field does not fit. */
function StackedField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>{label}</span>
      {children}
    </label>
  )
}

function ExplanationNotes() {
  return (
    <div style={{ ...CARD, borderLeft: '4px solid var(--ds-blue)', padding: '14px 16px' }}>
      <p style={{ fontSize: 13, color: 'var(--ds-t2)', lineHeight: 1.6, marginBottom: 10 }}>
        <b>How the outlook is built.</b> The current month starts from the latest check-in's cash. Its profit is the
        month-to-date figures scaled to a full month by how far through the month the check-in date is (a $6K MTD on
        the 15th becomes ~$12K). Every later month uses the run-rate profit for each center, plus any one-time items
        you've placed in that month.
      </p>
      <p style={{ fontSize: 13, color: 'var(--ds-t2)', lineHeight: 1.6 }}>
        Receivables and payables don't move the projection directly, because in a steady business they offset each
        other month to month. They feed true liquidity, which is the number that tells you whether a low bank balance
        is timing (liquidity high, cash low) or a real problem (both falling).
      </p>
    </div>
  )
}

