import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { MoneyField } from './MoneyField'
import type { ChargeCodeDef, ChargeCodeOverride, ChargeCalc } from '@/types/tms'

const CALC_OPTIONS: ChargeCalc[] = ['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT']

function emptyOverride(): ChargeCodeOverride {
  return { code: '', display: true, customerCode: null, label: null, category: null, calculatedBy: null, defaultAmountCents: null }
}

interface ChargeCodesEditorProps {
  overrides: ChargeCodeOverride[]
  catalog: ChargeCodeDef[]
  onChange: (overrides: ChargeCodeOverride[]) => void
  disabled?: boolean
}

export function ChargeCodesEditor({ overrides, catalog, onChange, disabled }: ChargeCodesEditorProps) {
  const catalogByCode = useMemo(() => {
    const map = new Map<string, ChargeCodeDef>()
    for (const c of catalog) map.set(c.code, c)
    return map
  }, [catalog])

  const update = (idx: number, patch: Partial<ChargeCodeOverride>) => {
    onChange(overrides.map((o, i) => (i === idx ? { ...o, ...patch } : o)))
  }

  const selectCatalogCode = (idx: number, code: string) => {
    const def = catalogByCode.get(code)
    update(idx, {
      code,
      label: def?.label ?? null,
      calculatedBy: def?.calculatedBy ?? null,
      defaultAmountCents: def?.defaultAmountCents ?? null,
    })
  }

  const add = () => onChange([...overrides, emptyOverride()])
  const remove = (idx: number) => onChange(overrides.filter((_, i) => i !== idx))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {overrides.length === 0 && <p className="tms-muted" style={{ fontSize: 12 }}>No charge-code overrides.</p>}
      {overrides.map((o, idx) => (
        <div key={idx} className="tms-card">
          <div className="tms-card-body" style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
              <div className="tms-grid tms-grid-2" style={{ flex: 1 }}>
                <TmsField label="Code">
                  <TmsSelect
                    value={o.code}
                    onChange={(e) => selectCatalogCode(idx, e.target.value)}
                    disabled={disabled}
                    placeholder="— select —"
                    options={catalog.map((c) => ({ value: c.code, label: `${c.label} (${c.code})` }))}
                  />
                </TmsField>
                <TmsField label="Customer code">
                  <TmsInput value={o.customerCode ?? ''} onChange={(e) => update(idx, { customerCode: e.target.value || null })} disabled={disabled} />
                </TmsField>
              </div>
              <label className="tms-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, paddingBottom: 10 }}>
                <input type="checkbox" checked={o.display} onChange={(e) => update(idx, { display: e.target.checked })} disabled={disabled} />
                Show
              </label>
              <TmsButton variant="ghost" size="sm" aria-label="Remove override" onClick={() => remove(idx)} disabled={disabled}>
                <Trash2 size={14} />
              </TmsButton>
            </div>
            <div className="tms-grid tms-grid-4">
              <TmsField label="Label override">
                <TmsInput value={o.label ?? ''} onChange={(e) => update(idx, { label: e.target.value || null })} disabled={disabled} />
              </TmsField>
              <TmsField label="Category override">
                <TmsInput value={o.category ?? ''} onChange={(e) => update(idx, { category: e.target.value || null })} disabled={disabled} />
              </TmsField>
              <TmsField label="Calc override">
                <TmsSelect
                  value={o.calculatedBy ?? ''}
                  onChange={(e) => update(idx, { calculatedBy: e.target.value ? (e.target.value as ChargeCalc) : null })}
                  disabled={disabled}
                  placeholder="— no override —"
                  options={CALC_OPTIONS.map((c) => ({ value: c, label: c }))}
                />
              </TmsField>
              <MoneyField label="Default amount" value={o.defaultAmountCents} onChange={(cents) => update(idx, { defaultAmountCents: cents })} disabled={disabled} />
            </div>
          </div>
        </div>
      ))}
      <TmsButton size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} /> Add override
      </TmsButton>
    </div>
  )
}
