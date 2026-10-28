import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MoneyField } from './MoneyField'
import type { PricingDefaults, PricingMode, ChargeCodeDef } from '@/types/tms'

const MODES: PricingMode[] = ['MARGIN', 'MARKUP', 'PROFIT']

interface PricingDefaultsFormProps {
  value: PricingDefaults
  onChange: (value: PricingDefaults) => void
  catalog: ChargeCodeDef[]
  disabled?: boolean
}

export function PricingDefaultsForm({ value, onChange, catalog, disabled }: PricingDefaultsFormProps) {
  const update = (patch: Partial<PricingDefaults>) => onChange({ ...value, ...patch })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Pricing mode</Label>
          <Select value={value.mode} onValueChange={(v) => update({ mode: v as PricingMode })} disabled={disabled}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default {value.mode === 'PROFIT' ? 'profit ($)' : 'basis points'}</Label>
          {value.mode === 'PROFIT' ? (
            <MoneyField value={value.defaultProfitCents} onChange={(cents) => update({ defaultProfitCents: cents })} disabled={disabled} />
          ) : (
            <Input
              type="number"
              min={0}
              max={10000}
              value={value.defaultBps ?? ''}
              onChange={(e) => update({ defaultBps: e.target.value ? Number(e.target.value) : null })}
              disabled={disabled}
              className="h-9 text-sm"
            />
          )}
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Single charge code</Label>
          <Select value={value.singleChargeCode ?? '__UNSET__'} onValueChange={(v) => update({ singleChargeCode: v === '__UNSET__' ? null : v })} disabled={disabled}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__UNSET__">— unset —</SelectItem>
              {catalog.map((c) => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <MoneyField label="Min profit ($)" value={value.minProfitCents} onChange={(cents) => update({ minProfitCents: cents })} disabled={disabled} />
        <MoneyField label="Max profit ($)" value={value.maxProfitCents} onChange={(cents) => update({ maxProfitCents: cents })} disabled={disabled} />
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Distribution</Label>
          <Input
            value={value.distribution ?? ''}
            onChange={(e) => update({ distribution: e.target.value || null })}
            disabled={disabled}
            className="h-9 text-sm"
          />
        </div>
      </div>
    </div>
  )
}
