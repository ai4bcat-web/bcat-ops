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
import { useMemo, useState } from 'react'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { MoneyField } from '@/features/directory/components/MoneyField'
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
  onSave: (charges: LoadChargeInput[]) => Promise<void>
}

function toDraft(charge: LoadChargeRecord): LoadChargeInput {
  return {
    side: charge.side,
    code: charge.code,
    label: charge.label ?? null,
    calculatedBy: charge.calculatedBy,
    rateCents: charge.rateCents,
    count: charge.count ?? 1,
    isRate: charge.isRate,
    sortOrder: charge.sortOrder,
    note: charge.note ?? null,
    orderId: charge.orderId ?? null,
    loadId: charge.loadId ?? null,
    loadCarrierId: charge.loadCarrierId ?? null,
    release: charge.release ?? null,
  }
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

export function FinancialLines({ charges, catalog, context, pricing, marginFloorBps, readOnly, onSave }: FinancialLinesProps) {
  const [draft, setDraft] = useState<LoadChargeInput[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Until the user touches a cell the grid mirrors the server rows, so a poll refresh is
  // never thrown away; the first edit forks a local draft that Save commits.
  const lines = draft ?? charges.map(toDraft)
  const dirty = draft != null

  const totals: FinancialTotals = useMemo(
    () => computeFinancials(lines, context, pricing, marginFloorBps),
    [lines, context, pricing, marginFloorBps],
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
    if (draft.some((l) => !l.code)) { setError('Every line needs a charge code.'); return }
    if (draft.some((l) => l.count != null && l.count < 0)) { setError('A count cannot be negative.'); return }
    setError(null)
    setSaving(true)
    try {
      await onSave(draft)
      setDraft(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Charges failed to save')
    } finally {
      setSaving(false)
    }
  }

  const overTopSpend = totals.costCents > totals.topSpendCents

  return (
    <div className="space-y-4">
      <TotalsBox totals={totals} overTopSpend={overTopSpend} />

      {SIDES.map(({ side, title }) => (
        <section key={side} className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
            {!readOnly && (
              <Button type="button" variant="outline" size="sm" onClick={() => addLine(side)}>
                <Plus size={14} className="mr-1" /> Add line
              </Button>
            )}
          </div>
          {sideRows(lines, side).length === 0 && (
            <p className="text-xs text-muted-foreground">No {side.toLowerCase()} charges.</p>
          )}
          {sideRows(lines, side).map(({ line, index }, position) => (
            <div key={index} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border bg-card p-2">
              <div className="col-span-3">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Code</Label>
                <select
                  aria-label={`${side} charge code ${position + 1}`}
                  value={line.code}
                  disabled={readOnly}
                  onChange={(e) => {
                    const def = catalog.find((c) => c.code === e.target.value)
                    update(index, {
                      code: e.target.value,
                      label: def?.label ?? null,
                      calculatedBy: def?.calculatedBy ?? line.calculatedBy,
                      isRate: isRateCode(e.target.value),
                    })
                  }}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">— select —</option>
                  {catalog.map((c) => <option key={c.code} value={c.code}>{c.label} ({c.code})</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Calculated by</Label>
                <select
                  aria-label={`${side} calculated by ${position + 1}`}
                  value={line.calculatedBy}
                  disabled={readOnly}
                  onChange={(e) => update(index, { calculatedBy: e.target.value as ChargeCalc })}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {CALC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <MoneyField
                  label={line.calculatedBy === 'PERCENT' ? 'Percent (bps)' : 'Rate'}
                  value={line.rateCents}
                  disabled={readOnly}
                  onChange={(cents) => update(index, { rateCents: cents ?? 0 })}
                />
              </div>
              <div className="col-span-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Count</Label>
                <Input
                  aria-label={`${side} count ${position + 1}`}
                  type="number"
                  min={0}
                  value={line.count ?? 1}
                  disabled={readOnly}
                  onChange={(e) => update(index, { count: Number(e.target.value) })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="col-span-2 pb-2 text-right text-sm tabular-nums">
                ${formatCents(totals.lines[index]?.amountCents ?? 0)}
                {line.isRate && <Badge variant="outline" className="ml-2 text-[10px]">RATE</Badge>}
              </div>
              <div className="col-span-1 flex justify-end pb-1">
                {!readOnly && (
                  <Button
                    type="button" variant="ghost" size="icon" className="h-7 w-7"
                    aria-label={`Remove ${side} line ${position + 1}`}
                    onClick={() => setDraft(lines.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <Button type="button" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save charges'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => { setDraft(null); setError(null) }} disabled={!dirty || saving}>
            Discard
          </Button>
        </div>
      )}
    </div>
  )
}

function TotalsBox({ totals, overTopSpend }: { totals: FinancialTotals; overTopSpend: boolean }) {
  const cells: { label: string; value: string }[] = [
    { label: 'Customer Rate', value: `$${formatCents(totals.customerRateCents)}` },
    { label: 'Revenue', value: `$${formatCents(totals.revenueCents)}` },
    { label: 'Carrier Rate', value: `$${formatCents(totals.carrierRateCents)}` },
    { label: 'Cost', value: `$${formatCents(totals.costCents)}` },
    { label: 'Profit', value: `$${formatCents(totals.profitCents)}` },
    { label: 'Margin', value: `${(totals.marginBps / 100).toFixed(2)}%` },
    { label: 'Top spend', value: `$${formatCents(totals.topSpendCents)}` },
    { label: 'Target buy', value: totals.targetBuyCents != null ? `$${formatCents(totals.targetBuyCents)}` : '—' },
  ]
  return (
    <div data-testid="financial-totals" className="rounded-lg border border-border bg-muted/30 p-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label}>
            <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.label}</dt>
            <dd className="text-sm font-medium tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>
      {overTopSpend && (
        <p className="mt-2 flex items-center gap-1 text-xs text-amber-600">
          <AlertTriangle size={12} /> Carrier cost exceeds top spend — booking will warn.
        </p>
      )}
    </div>
  )
}
