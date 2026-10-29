import { TmsField, TmsInput, TmsTextarea } from '@/features/tms/kit'
import type { QuotingDefaults } from '@/types/tms'

interface QuotingDefaultsFormProps {
  value: QuotingDefaults
  onChange: (value: QuotingDefaults) => void
  disabled?: boolean
}

function linesToArray(value: string): string[] {
  return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function arrayToLines(value: string[] | null | undefined): string {
  return (value ?? []).join('\n')
}

export function QuotingDefaultsForm({ value, onChange, disabled }: QuotingDefaultsFormProps) {
  const update = (patch: Partial<QuotingDefaults>) => onChange({ ...value, ...patch })

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="tms-grid tms-grid-3">
        <TmsField label="Default mode">
          <TmsInput value={value.defaultMode ?? ''} onChange={(e) => update({ defaultMode: e.target.value || null })} disabled={disabled} />
        </TmsField>
        <TmsField label="Hours to quote">
          <TmsInput
            type="number"
            min={0}
            value={value.hoursToQuote ?? ''}
            onChange={(e) => update({ hoursToQuote: e.target.value ? Number(e.target.value) : null })}
            disabled={disabled}
          />
        </TmsField>
        <TmsField label="Portal LTL dispatch">
          <TmsInput
            value={value.portalLtlDispatchMode ?? ''}
            onChange={(e) => update({ portalLtlDispatchMode: e.target.value || null })}
            disabled={disabled}
          />
        </TmsField>
      </div>
      <div className="tms-grid tms-grid-2">
        <TmsField label="Portal status mask">
          <TmsTextarea
            value={arrayToLines(value.portalStatusMask)}
            onChange={(e) => update({ portalStatusMask: linesToArray(e.target.value) })}
            disabled={disabled}
            placeholder="One status per line"
          />
        </TmsField>
        <TmsField label="Blocked LTL carrier IDs">
          <TmsTextarea
            value={arrayToLines(value.blockedLtlCarrierIds)}
            onChange={(e) => update({ blockedLtlCarrierIds: linesToArray(e.target.value) })}
            disabled={disabled}
            placeholder="One ID per line"
          />
        </TmsField>
      </div>
      <TmsField label="Self-quote carrier IDs">
        <TmsTextarea
          value={arrayToLines(value.selfQuoteCarrierIds)}
          onChange={(e) => update({ selfQuoteCarrierIds: linesToArray(e.target.value) })}
          disabled={disabled}
          placeholder="One ID per line"
        />
      </TmsField>
      <TmsField label="Notes">
        <TmsTextarea value={value.notes ?? ''} onChange={(e) => update({ notes: e.target.value || null })} disabled={disabled} />
      </TmsField>
    </div>
  )
}
