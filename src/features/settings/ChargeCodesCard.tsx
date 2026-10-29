/**
 * The org charge-code catalog: every code a charge on a load, a quote or an invoice
 * can be raised under, and what it means.
 *
 * A customer may override a code's label, category, calculation or amount on their
 * own profile, but the code itself has to exist here first — `chargeCodeOverrides`
 * picks from this list. The Lambda refuses a row with no code or no label
 * (`validateChargeCodes`), so both are checked here rather than discovered as a
 * failed save with a dozen edited rows on screen.
 *
 * Amounts are typed in dollars and stored as integer cents; nothing in this app does
 * floating-point money, so the box goes through `parseCents`, which refuses anything
 * that is not a plain decimal.
 */
import { useEffect, useState } from 'react'
import { Plus, Save, Tags, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatCents as dollarsOf, parseCents } from '@/lib/tmsDirectory'
import type { ChargeCalc, ChargeCodeDef, TmsSettings } from '@/types/tms'

/** The same four the directory Lambda validates `calculatedBy` against. */
const CHARGE_CALCS: ChargeCalc[] = ['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT']

const CALC_LABELS: Record<ChargeCalc, string> = {
  FLAT: 'Flat amount',
  PER_MILE: 'Per mile',
  PER_CWT: 'Per hundredweight',
  PERCENT: 'Percent of linehaul',
}

/** A row as it is edited: the amount stays the text that was typed until it is saved. */
interface CodeRow {
  code: string
  label: string
  category: string
  calculatedBy: ChargeCalc
  amount: string
}

/** The typed amount as cents, or null while the box holds something that is not one. */
function centsOrNull(text: string): number | null {
  try {
    return parseCents(text)
  } catch {
    return null
  }
}

export function ChargeCodesCard() {
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [rows, setRows] = useState<CodeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    getTmsSettings()
      .then((s: TmsSettings | null) => {
        setSettings(s)
        setRows((s?.chargeCodes ?? []).map((c) => ({
          code: c.code,
          label: c.label,
          category: c.category ?? '',
          calculatedBy: c.calculatedBy,
          amount: c.defaultAmountCents != null ? dollarsOf(c.defaultAmountCents) : '',
        })))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load settings'))
      .finally(() => setLoading(false))
  }, [])

  const update = (index: number, patch: Partial<CodeRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const save = async () => {
    setError(null)
    const chargeCodes: ChargeCodeDef[] = []
    for (const [i, row] of rows.entries()) {
      const code = row.code.trim()
      const label = row.label.trim()
      if (!code) { setError(`Charge code ${i + 1} needs a code`); return }
      if (!label) { setError(`Charge code ${code} needs a label`); return }
      let defaultAmountCents: number | null
      try {
        defaultAmountCents = parseCents(row.amount)
      } catch (e) {
        setError(`${code}: ${e instanceof Error ? e.message : 'that is not an amount'}`)
        return
      }
      chargeCodes.push({
        code,
        label,
        category: row.category.trim() || null,
        calculatedBy: row.calculatedBy,
        defaultAmountCents,
      })
    }

    setSaving(true)
    try {
      const updated = await saveTmsSettings({ chargeCodes }, settings?.updatedAt ?? undefined)
      setSettings(updated)
      toast.success('Charge codes saved')
    } catch (e) {
      // The Lambda's own sentence, verbatim — it refuses for reasons this card cannot see.
      setError(e instanceof Error ? e.message : 'Could not save settings')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center gap-2.5">
        <Tags size={16} style={{ color: 'var(--ds-t3)' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Charge codes</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
            Every code a charge can be raised under. A customer may override the label, category, calculation or amount — but only for a code that exists here.
          </div>
        </div>
      </div>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-3">
          {rows.length === 0 && <p className="text-xs text-muted-foreground">No charge codes yet.</p>}

          {rows.length > 0 && (
            <div className="grid grid-cols-[7rem_1fr_8rem_9rem_7rem_2rem] gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <div>Code</div>
              <div>Label</div>
              <div>Category</div>
              <div>Calculated by</div>
              <div>Default $</div>
              <div />
            </div>
          )}

          {rows.map((row, i) => {
            const cents = centsOrNull(row.amount)
            const hint = cents != null ? formatCents(cents) : null
            return (
              <div key={i} className="grid grid-cols-[7rem_1fr_8rem_9rem_7rem_2rem] items-center gap-2">
                <Input
                  aria-label={`Charge code ${i + 1} code`}
                  value={row.code}
                  onChange={(e) => update(i, { code: e.target.value.toUpperCase() })}
                  className="h-9 text-sm"
                />
                <Input
                  aria-label={`Charge code ${i + 1} label`}
                  value={row.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  className="h-9 text-sm"
                />
                <Input
                  aria-label={`Charge code ${i + 1} category`}
                  value={row.category}
                  onChange={(e) => update(i, { category: e.target.value })}
                  className="h-9 text-sm"
                />
                <select
                  aria-label={`Charge code ${i + 1} calculated by`}
                  value={row.calculatedBy}
                  onChange={(e) => update(i, { calculatedBy: e.target.value as ChargeCalc })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {CHARGE_CALCS.map((c) => <option key={c} value={c}>{CALC_LABELS[c]}</option>)}
                </select>
                <div>
                  <Input
                    aria-label={`Charge code ${i + 1} default amount`}
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                    placeholder="0.00"
                    className="h-9 text-sm"
                  />
                  {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={`Remove charge code ${i + 1}`}
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            )
          })}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setRows((prev) => [...prev, { code: '', label: '', category: '', calculatedBy: 'FLAT', amount: '' }])}
            >
              <Plus size={14} /> Add charge code
            </Button>
            <Label className="text-xs text-muted-foreground">
              Amounts are typed in dollars and stored as integer cents.
            </Label>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" size="sm" className="h-8 gap-1" onClick={save} disabled={saving}>
            <Save className="size-3.5" /> Save charge codes
          </Button>
        </div>
      )}
    </div>
  )
}
