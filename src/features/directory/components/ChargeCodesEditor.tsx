import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
    <div className="space-y-3">
      {overrides.length === 0 && <p className="text-xs text-muted-foreground">No charge-code overrides.</p>}
      {overrides.map((o, idx) => (
        <div key={idx} className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="grid grid-cols-2 gap-3 flex-1">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Code</Label>
                <select
                  value={o.code}
                  onChange={(e) => selectCatalogCode(idx, e.target.value)}
                  disabled={disabled}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">— select —</option>
                  {catalog.map((c) => (
                    <option key={c.code} value={c.code}>{c.label} ({c.code})</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Customer code</Label>
                <Input value={o.customerCode ?? ''} onChange={(e) => update(idx, { customerCode: e.target.value || null })} disabled={disabled} className="h-9 text-sm" />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-4">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Switch checked={o.display} onCheckedChange={(checked) => update(idx, { display: checked })} disabled={disabled} />
                Show
              </Label>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)} disabled={disabled}>
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Label override</Label>
              <Input value={o.label ?? ''} onChange={(e) => update(idx, { label: e.target.value || null })} disabled={disabled} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Category override</Label>
              <Input value={o.category ?? ''} onChange={(e) => update(idx, { category: e.target.value || null })} disabled={disabled} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Calc override</Label>
              <Select value={o.calculatedBy ?? '__UNSET__'} onValueChange={(v) => update(idx, { calculatedBy: v === '__UNSET__' ? null : (v as ChargeCalc) })} disabled={disabled}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__UNSET__">— no override —</SelectItem>
                  {CALC_OPTIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <MoneyField label="Default amount" value={o.defaultAmountCents} onChange={(cents) => update(idx, { defaultAmountCents: cents })} disabled={disabled} />
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} className="mr-1" /> Add override
      </Button>
    </div>
  )
}
