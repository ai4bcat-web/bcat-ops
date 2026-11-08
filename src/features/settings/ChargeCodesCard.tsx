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
import { TmsButton, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { formatCents } from '@/lib/invoiceBuild'
import { formatCents as dollarsOf, parseCents } from '@/lib/tmsDirectory'
import type { ChargeCalc, ChargeCodeDef, ChargeCodeVisibility, TmsSettings } from '@/types/tms'
import { ErrorText, Hint, Loading, SettingsCard, Stack } from './settingsKit'

/** The same four the directory Lambda validates `calculatedBy` against. */
const CHARGE_CALCS: ChargeCalc[] = ['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT']

const CALC_LABELS: Record<ChargeCalc, string> = {
  FLAT: 'Flat amount',
  PER_MILE: 'Per mile',
  PER_CWT: 'Per hundredweight',
  PERCENT: 'Percent of linehaul',
}

const VISIBILITIES: ChargeCodeVisibility[] = ['INTERNAL', 'CUSTOMER', 'CARRIER']

const VISIBILITY_LABELS: Record<ChargeCodeVisibility, string> = {
  INTERNAL: 'Internal',
  CUSTOMER: 'Customer',
  CARRIER: 'Carrier',
}

/** The seven columns of a code row, header and body alike. */
const ROW_COLUMNS = { gridTemplateColumns: '7rem minmax(0, 1fr) 8rem 9rem 7rem 7rem 2rem', alignItems: 'center' } as const

/** A row as it is edited: the amount stays the text that was typed until it is saved. */
interface CodeRow {
  code: string
  label: string
  category: string
  calculatedBy: ChargeCalc
  amount: string
  visibility: ChargeCodeVisibility
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
          visibility: c.visibility ?? 'INTERNAL',
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
        visibility: row.visibility,
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
    <SettingsCard
      icon={Tags}
      title="Charge codes"
      description="Every code a charge can be raised under. A customer may override the label, category, calculation or amount — but only for a code that exists here."
    >
      {loading ? <Loading /> : (
        <Stack>
          {rows.length === 0 && <Hint>No charge codes yet.</Hint>}

          {rows.length > 0 && (
            <div className="tms-grid tms-field-label" style={{ ...ROW_COLUMNS, gap: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <div>Code</div>
              <div>Label</div>
              <div>Category</div>
              <div>Calculated by</div>
              <div>Default $</div>
              <div>Visibility</div>
              <div />
            </div>
          )}

          {rows.map((row, i) => {
            const cents = centsOrNull(row.amount)
            return (
              <div key={i} className="tms-grid" style={{ ...ROW_COLUMNS, gap: 8 }}>
                <TmsInput
                  aria-label={`Charge code ${i + 1} code`}
                  value={row.code}
                  onChange={(e) => update(i, { code: e.target.value.toUpperCase() })}
                />
                <TmsInput
                  aria-label={`Charge code ${i + 1} label`}
                  value={row.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
                <TmsInput
                  aria-label={`Charge code ${i + 1} category`}
                  value={row.category}
                  onChange={(e) => update(i, { category: e.target.value })}
                />
                <TmsSelect
                  aria-label={`Charge code ${i + 1} calculated by`}
                  value={row.calculatedBy}
                  onChange={(e) => update(i, { calculatedBy: e.target.value as ChargeCalc })}
                >
                  {CHARGE_CALCS.map((c) => <option key={c} value={c}>{CALC_LABELS[c]}</option>)}
                </TmsSelect>
                <div>
                  <TmsInput
                    aria-label={`Charge code ${i + 1} default amount`}
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                    placeholder="0.00"
                  />
                  {cents != null && <span className="tms-field-hint">{formatCents(cents)}</span>}
                </div>
                <TmsSelect
                  aria-label={`Charge code ${i + 1} visibility`}
                  value={row.visibility}
                  onChange={(e) => update(i, { visibility: e.target.value as ChargeCodeVisibility })}
                >
                  {VISIBILITIES.map((v) => <option key={v} value={v}>{VISIBILITY_LABELS[v]}</option>)}
                </TmsSelect>
                <TmsIconButton
                  shape="plain"
                  aria-label={`Remove charge code ${i + 1}`}
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </TmsIconButton>
              </div>
            )
          })}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <TmsButton
              size="sm"
              onClick={() => setRows((prev) => [...prev, { code: '', label: '', category: '', calculatedBy: 'FLAT', amount: '', visibility: 'INTERNAL' }])}
            >
              <Plus size={14} /> Add charge code
            </TmsButton>
            <Hint>Amounts are typed in dollars and stored as integer cents.</Hint>
          </div>

          {error && <ErrorText>{error}</ErrorText>}
          <div>
            <TmsButton variant="primary" size="sm" onClick={save} disabled={saving}>
              <Save size={14} /> Save charge codes
            </TmsButton>
          </div>
        </Stack>
      )}
    </SettingsCard>
  )
}
