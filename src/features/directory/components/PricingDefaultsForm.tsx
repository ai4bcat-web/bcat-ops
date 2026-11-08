import { TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
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
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="tms-grid tms-grid-3">
        <TmsField label="Pricing mode">
          <TmsSelect
            value={value.mode}
            onChange={(e) => update({ mode: e.target.value as PricingMode })}
            disabled={disabled}
            options={MODES.map((m) => ({ value: m, label: m }))}
          />
        </TmsField>
        <div>
          {value.mode === 'PROFIT' ? (
            <MoneyField label="Default profit ($)" value={value.defaultProfitCents} onChange={(cents) => update({ defaultProfitCents: cents })} disabled={disabled} />
          ) : (
            <TmsField label="Default basis points">
              <TmsInput
                type="number"
                min={0}
                max={10000}
                value={value.defaultBps ?? ''}
                onChange={(e) => update({ defaultBps: e.target.value ? Number(e.target.value) : null })}
                disabled={disabled}
              />
            </TmsField>
          )}
        </div>
        <TmsField label="Single charge code">
          <TmsSelect
            value={value.singleChargeCode ?? ''}
            onChange={(e) => update({ singleChargeCode: e.target.value || null })}
            disabled={disabled}
            placeholder="— unset —"
            options={catalog.map((c) => ({ value: c.code, label: c.label }))}
          />
        </TmsField>
      </div>
      <div className="tms-grid tms-grid-3">
        <MoneyField label="Min profit ($)" value={value.minProfitCents} onChange={(cents) => update({ minProfitCents: cents })} disabled={disabled} />
        <MoneyField label="Max profit ($)" value={value.maxProfitCents} onChange={(cents) => update({ maxProfitCents: cents })} disabled={disabled} />
        <TmsField label="Distribution">
          <TmsInput
            value={value.distribution ?? ''}
            onChange={(e) => update({ distribution: e.target.value || null })}
            disabled={disabled}
          />
        </TmsField>
      </div>
    </div>
  )
}
