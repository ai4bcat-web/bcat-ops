import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default mode</Label>
          <Input value={value.defaultMode ?? ''} onChange={(e) => update({ defaultMode: e.target.value || null })} disabled={disabled} className="h-9 text-sm" />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Hours to quote</Label>
          <Input
            type="number"
            min={0}
            value={value.hoursToQuote ?? ''}
            onChange={(e) => update({ hoursToQuote: e.target.value ? Number(e.target.value) : null })}
            disabled={disabled}
            className="h-9 text-sm"
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Portal LTL dispatch</Label>
          <Input
            value={value.portalLtlDispatchMode ?? ''}
            onChange={(e) => update({ portalLtlDispatchMode: e.target.value || null })}
            disabled={disabled}
            className="h-9 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Portal status mask</Label>
          <Textarea
            value={arrayToLines(value.portalStatusMask)}
            onChange={(e) => update({ portalStatusMask: linesToArray(e.target.value) })}
            disabled={disabled}
            className="text-sm min-h-[72px]"
            placeholder="One status per line"
          />
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Blocked LTL carrier IDs</Label>
          <Textarea
            value={arrayToLines(value.blockedLtlCarrierIds)}
            onChange={(e) => update({ blockedLtlCarrierIds: linesToArray(e.target.value) })}
            disabled={disabled}
            className="text-sm min-h-[72px]"
            placeholder="One ID per line"
          />
        </div>
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Self-quote carrier IDs</Label>
        <Textarea
          value={arrayToLines(value.selfQuoteCarrierIds)}
          onChange={(e) => update({ selfQuoteCarrierIds: linesToArray(e.target.value) })}
          disabled={disabled}
          className="text-sm min-h-[72px]"
          placeholder="One ID per line"
        />
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Notes</Label>
        <Textarea value={value.notes ?? ''} onChange={(e) => update({ notes: e.target.value || null })} disabled={disabled} className="text-sm" />
      </div>
    </div>
  )
}
