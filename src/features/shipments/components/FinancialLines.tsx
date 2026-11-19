/**
 * The Financials grid: customer (sell) lines and carrier (buy) lines, each priced by its
 * charge code's calculation, with the money box MVMNT shows above them — Customer Rate,
 * Revenue, Carrier Rate, Cost, Profit, Margin, Top spend, Target buy (spec §6.8 "Money
 * vocabulary").
 *
 * The math is `computeFinancials`; this component never adds its own arithmetic, so what
 * the screen shows is exactly what `RECALC_CHARGES` will store. Over-top-spend and
 * negative-buy are warnings here and refusals server-side — the editor never blocks a
 * number the Lambda would accept.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsButton, TmsCard, TmsInput, TmsSelect, TmsStatRow } from '@/features/tms/kit'
import { Label } from '@/components/ui/label'
import { MoneyField } from '@/features/directory/components/MoneyField'
import { chargeToDraft } from '@/lib/carrierInvoiceAmount'
import { computeFinancials, isRateCode } from '@/lib/shipmentCharges'
import type { ChargeContext, FinancialTotals } from '@/lib/shipmentCharges'
import { formatCents } from '@/lib/tmsDirectory'
import type {
  ChargeCalc, ChargeCodeDef, ChargeSide, LoadChargeInput, LoadChargeRecord, PricingDefaults,
} from '@/types/tms'

const CALC_OPTIONS: { value: ChargeCalc; label: string }[] = [
  { value: 'FLAT', label: 'Flat' },
  { value: 'PER_MILE', label: 'Per mile' },
  { value: 'PER_CWT', label: 'Per cwt' },
  { value: 'PERCENT', label: 'Percent' },
]

const SIDES: { side: ChargeSide; title: string }[] = [
  { side: 'CUSTOMER', title: 'Customer charges' },
  { side: 'CARRIER', title: 'Carrier charges' },
]


interface FinancialLinesProps {
  charges: LoadChargeRecord[]
  catalog: ChargeCodeDef[]
  context: ChargeContext
  pricing: PricingDefaults | null
  marginFloorBps: number | null
  /** Frozen (invoiced) shipments and non-draft reads render the grid without inputs. */
  readOnly?: boolean
  /** Also drop coded lines worth nothing when saving (the AP dialog; a $0 TONU placeholder is not a charge). */
  dropZeroLines?: boolean
  /** Shown above Save: whatever the save needs besides the lines (a reason for the change). */
  beforeSave?: ReactNode
  /** Why Save cannot be pressed yet, in words; the button is held until it is null. */
  saveBlocked?: string | null
  /** Sides shown but not editable (the AP dialog shows the customer's lines beside the carrier's). */
  readOnlySides?: ChargeSide[]
  /** Lines that count toward the totals but are neither shown nor saved (the shipment's other carriers). */
  extraLines?: LoadChargeRecord[]
  /** A side to mark, with the label that says what editing it changes. */
  highlight?: { side: ChargeSide; label: string }
  /** Show dashes, not $0 and a made-up profit, when the shipment has no customer revenue. */
  dashWithoutCustomer?: boolean
  /** Tells the parent whether there are unsaved edits, so closing can ask before throwing them away. */
  onDirtyChange?: (dirty: boolean) => void
  onSave: (charges: LoadChargeInput[]) => Promise<void>
}

/**
 * One side's lines, each carrying its position in the single flat draft array. Edits
 * address the flat index; labels and row numbers use the per-side position, so "Carrier
 * line 1" means the first carrier line and not the third line overall.
 */
function sideRows(lines: LoadChargeInput[], side: ChargeSide): { line: LoadChargeInput; index: number }[] {
  const rows: { line: LoadChargeInput; index: number }[] = []
  lines.forEach((line, index) => { if (line.side === side) rows.push({ line, index }) })
  return rows
}

/** A line nobody filled in: no code, no rate. It is never a charge, so it is dropped rather than refused. */
const isBlankLine = (line: LoadChargeInput): boolean => !line.code && !line.rateCents

/** The lines Save sends: blank lines gone (and, where asked, zero-dollar coded ones), positions renumbered per side. */
function linesToSave(draft: LoadChargeInput[], dropZeroLines: boolean): LoadChargeInput[] {
  const kept = draft.filter((l) => !isBlankLine(l) && !(dropZeroLines && l.code && !l.isRate && !l.rateCents))
  const next: Record<ChargeSide, number> = { CUSTOMER: 0, CARRIER: 0 }
  return kept.map((l) => ({ ...l, sortOrder: next[l.side]++ }))
}

export function FinancialLines({ charges, catalog, context, pricing, marginFloorBps, readOnly, dropZeroLines = false, readOnlySides = [], extraLines = [], highlight, dashWithoutCustomer = false, beforeSave, saveBlocked = null, onDirtyChange, onSave }: FinancialLinesProps) {
  const [draft, setDraft] = useState<LoadChargeInput[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Until the user touches a cell the grid mirrors the server rows, so a poll refresh is
  // never thrown away; the first edit forks a local draft that Save commits.
  const lines = draft ?? charges.map(chargeToDraft)
  const dirty = draft != null
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  const dropping = draft ? draft.length - linesToSave(draft, dropZeroLines).length : 0

  const totals: FinancialTotals = useMemo(
    () => computeFinancials([...lines, ...extraLines.map(chargeToDraft)], context, pricing, marginFloorBps),
    [lines, extraLines, context, pricing, marginFloorBps],
  )

  const update = (index: number, patch: Partial<LoadChargeInput>) =>
    setDraft(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  const addLine = (side: ChargeSide) => setDraft([
    ...lines,
    {
      side, code: '', label: null, calculatedBy: 'FLAT', rateCents: 0, count: 1,
      isRate: false, sortOrder: lines.filter((l) => l.side === side).length,
      note: null, orderId: null, loadId: null, loadCarrierId: null, release: null,
    },
  ])

  const save = async () => {
    if (!draft) return
    const toSave = linesToSave(draft, dropZeroLines)
    const uncoded = toSave.find((l) => !l.code)
    if (uncoded) {
      setError(`Pick a charge code for the $${formatCents(uncoded.rateCents)} ${uncoded.side.toLowerCase()} line, or remove it.`)
      return
    }
    if (toSave.some((l) => l.count != null && l.count < 0)) { setError('A count cannot be negative.'); return }
    setError(null)
    setSaving(true)
    try {
      await onSave(toSave)
      setDraft(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Charges failed to save')
    } finally {
      setSaving(false)
    }
  }

  const overTopSpend = totals.costCents > totals.topSpendCents
  const noCustomer = dashWithoutCustomer && !lines.some((l) => l.side === 'CUSTOMER') && totals.revenueCents === 0

  return (
    <div className="space-y-4">
      <TotalsBox
        totals={totals}
        overTopSpend={overTopSpend && !noCustomer}
        noCustomer={noCustomer}
      />

      {SIDES.map(({ side, title }) => {
        const sideReadOnly = readOnly || readOnlySides.includes(side)
        const marked = highlight?.side === side
        return (
        <TmsCard
          key={side}
          title={title}
          className={marked ? 'border-2 border-[color:var(--tms-primary)] bg-[color:var(--tms-card)]' : undefined}
          actions={!sideReadOnly ? (
            <TmsButton type="button" size="sm" onClick={() => addLine(side)}>
              <Plus size={14} className="mr-1" /> Add line
            </TmsButton>
          ) : undefined}
        >
          {marked && (
            <p className="mb-2 text-xs font-semibold" data-testid="highlight-label">
              <TmsBadge tone="blue" className="mr-2 text-[10px]">AP record</TmsBadge>{highlight.label}
            </p>
          )}
          {sideRows(lines, side).length === 0 && (
            <p className="text-xs tms-muted">No {side.toLowerCase()} charges.</p>
          )}
          {sideRows(lines, side).map(({ line, index }, position) => (
            <div key={index} className="grid grid-cols-12 items-end gap-2 rounded-[var(--tms-radius)] border border-[color:var(--tms-border)] bg-[color:var(--tms-card)] p-2">
              <div className="col-span-3">
                <Label className="tms-field-label">Code</Label>
                <TmsSelect
                  aria-label={`${side} charge code ${position + 1}`}
                  value={line.code}
                  disabled={sideReadOnly}
                  onChange={(e) => {
                    const def = catalog.find((c) => c.code === e.target.value)
                    update(index, {
                      code: e.target.value,
                      label: def?.label ?? null,
                      calculatedBy: def?.calculatedBy ?? line.calculatedBy,
                      isRate: isRateCode(e.target.value),
                    })
                  }}
                  className="mt-1 w-full"
                >
                  <option value="">— select —</option>
                  {/* A stored code the catalog no longer lists still shows, so the line is not read as blank. */}
                  {line.code && !catalog.some((c) => c.code === line.code) && <option value={line.code}>{line.label ?? line.code} ({line.code})</option>}
                  {catalog.map((c) => <option key={c.code} value={c.code}>{c.label} ({c.code})</option>)}
                </TmsSelect>
              </div>
              <div className="col-span-2">
                <Label className="tms-field-label">Calculated by</Label>
                <TmsSelect
                  aria-label={`${side} calculated by ${position + 1}`}
                  value={line.calculatedBy}
                  disabled={sideReadOnly}
                  onChange={(e) => update(index, { calculatedBy: e.target.value as ChargeCalc })}
                  className="mt-1 w-full"
                >
                  {CALC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </TmsSelect>
              </div>
              <div className="col-span-2">
                <MoneyField
                  label={line.calculatedBy === 'PERCENT' ? 'Percent (bps)' : 'Rate'}
                  value={line.rateCents}
                  disabled={sideReadOnly}
                  onChange={(cents) => update(index, { rateCents: cents ?? 0 })}
                />
              </div>
              <div className="col-span-2">
                <Label className="tms-field-label">Count</Label>
                <TmsInput
                  aria-label={`${side} count ${position + 1}`}
                  type="number"
                  min={0}
                  value={line.count ?? 1}
                  disabled={sideReadOnly}
                  onChange={(e) => update(index, { count: Number(e.target.value) })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="col-span-2 pb-2 text-right text-sm tabular-nums">
                ${formatCents(totals.lines[index]?.amountCents ?? 0)}
                {line.isRate && <TmsBadge tone="gray" className="ml-2 text-[10px]">RATE</TmsBadge>}
              </div>
              <div className="col-span-1 flex justify-end pb-1">
                {!sideReadOnly && (
                  <TmsButton variant="ghost"
                    type="button" size="sm"
                    // .tms-btn-sm pads 12px a side, which squeezed a 28px-wide button's icon to a dot.
                    style={{ width: 32, padding: 0 }}
                    title="Delete line"
                    aria-label={`Remove ${side} line ${position + 1}`}
                    onClick={() => setDraft(lines.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={16} />
                  </TmsButton>
                )}
              </div>
            </div>
          ))}
        </TmsCard>
        )
      })}

      {error && <p className="text-xs text-[color:var(--tms-badge-red)]">{error}</p>}
      {dropping > 0 && (
        <p className="text-xs tms-muted">{dropping === 1 ? '1 empty line is' : `${dropping} empty lines are`} left out when you save.</p>
      )}
      {!readOnly && beforeSave}
      {!readOnly && dirty && saveBlocked && <p className="text-xs tms-muted">{saveBlocked}</p>}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <TmsButton variant="primary" type="button" onClick={save} disabled={!dirty || saving || saveBlocked != null}>
            {saving ? 'Saving…' : 'Save charges'}
          </TmsButton>
          <TmsButton variant="ghost" type="button" onClick={() => { setDraft(null); setError(null) }} disabled={!dirty || saving}>
            Discard
          </TmsButton>
        </div>
      )}
    </div>
  )
}

function TotalsBox({ totals, overTopSpend, noCustomer }: { totals: FinancialTotals; overTopSpend: boolean; noCustomer: boolean }) {
  const dash = '—'
  const cells: { label: string; value: string }[] = [
    { label: 'Customer Rate', value: noCustomer ? dash : `$${formatCents(totals.customerRateCents)}` },
    { label: 'Revenue', value: noCustomer ? dash : `$${formatCents(totals.revenueCents)}` },
    { label: 'Carrier Rate', value: `$${formatCents(totals.carrierRateCents)}` },
    { label: 'Cost', value: `$${formatCents(totals.costCents)}` },
    { label: 'Profit', value: noCustomer ? dash : `$${formatCents(totals.profitCents)}` },
    { label: 'Margin', value: noCustomer ? dash : `${(totals.marginBps / 100).toFixed(2)}%` },
    { label: 'Top spend', value: noCustomer ? dash : `$${formatCents(totals.topSpendCents)}` },
    { label: 'Target buy', value: !noCustomer && totals.targetBuyCents != null ? `$${formatCents(totals.targetBuyCents)}` : dash },
  ]
  return (
    <div data-testid="financial-totals" className="space-y-2">
      <TmsStatRow compact columns={4} aria-label="Financial totals" items={cells.map((c) => ({ key: c.label, label: c.label, value: c.value }))} />
      {overTopSpend && (
        <TmsAlert tone="orange" icon={AlertTriangle}>
          Carrier cost exceeds top spend — booking will warn.
        </TmsAlert>
      )}
    </div>
  )
}
