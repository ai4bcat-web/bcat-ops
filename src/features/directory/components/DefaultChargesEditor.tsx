import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    <div className="space-y-3">
      {charges.length === 0 && <p className="text-xs text-muted-foreground">No default charges.</p>}
      {charges.map((c, idx) => (
        <div key={idx} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border bg-card p-3">
          <div className="col-span-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Charge code</Label>
            <select
              value={c.code}
              onChange={(e) => update(idx, { code: e.target.value })}
              disabled={disabled}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">— select —</option>
              {catalog.map((cc) => (
                <option key={cc.code} value={cc.code}>{cc.label} ({cc.code})</option>
              ))}
            </select>
          </div>
          <div className="col-span-3">
            <MoneyField label="Amount" value={c.amountCents} onChange={(cents) => update(idx, { amountCents: cents ?? 0 })} disabled={disabled} />
          </div>
          <div className="col-span-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Count</Label>
            <Input
              type="number"
              min={1}
              value={c.count ?? 1}
              onChange={(e) => update(idx, { count: Math.max(1, Number(e.target.value)) })}
              disabled={disabled}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2 flex justify-end">
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)} disabled={disabled}>
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} className="mr-1" /> Add default charge
      </Button>
    </div>
  )
}
