import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { MoneyField } from './MoneyField'
import type { DefaultCharge, ChargeCodeDef } from '@/types/tms'

function emptyCharge(): DefaultCharge {
  return { code: '', amountCents: 0 }
}

interface DefaultChargesEditorProps {
  charges: DefaultCharge[]
  catalog: ChargeCodeDef[]
  onChange: (charges: DefaultCharge[]) => void
  disabled?: boolean
}

export function DefaultChargesEditor({ charges, catalog, onChange, disabled }: DefaultChargesEditorProps) {
  const update = (idx: number, patch: Partial<DefaultCharge>) => {
    onChange(charges.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  }

  const add = () => onChange([...charges, emptyCharge()])
  const remove = (idx: number) => onChange(charges.filter((_, i) => i !== idx))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {charges.length === 0 && <p className="tms-muted" style={{ fontSize: 12 }}>No default charges.</p>}
      {charges.map((c, idx) => (
        <div key={idx} className="tms-card">
          <div className="tms-card-body tms-grid tms-grid-4" style={{ alignItems: 'flex-end' }}>
            <TmsField label="Charge code">
              <TmsSelect
                value={c.code}
                onChange={(e) => update(idx, { code: e.target.value })}
                disabled={disabled}
                placeholder="— select —"
                options={catalog.map((cc) => ({ value: cc.code, label: `${cc.label} (${cc.code})` }))}
              />
            </TmsField>
            <MoneyField label="Amount" value={c.amountCents} onChange={(cents) => update(idx, { amountCents: cents ?? 0 })} disabled={disabled} />
            <TmsField label="Count">
              <TmsInput
                type="number"
                min={1}
                value={c.count ?? 1}
                onChange={(e) => update(idx, { count: Math.max(1, Number(e.target.value)) })}
                disabled={disabled}
              />
            </TmsField>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <TmsButton variant="ghost" size="sm" aria-label="Remove charge" onClick={() => remove(idx)} disabled={disabled}>
                <Trash2 size={14} />
              </TmsButton>
            </div>
          </div>
        </div>
      ))}
      <TmsButton size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} /> Add default charge
      </TmsButton>
    </div>
  )
}
