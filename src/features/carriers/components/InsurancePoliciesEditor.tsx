/**
 * The carrier's certificates of insurance. These are a JSON array on the carrier row,
 * not their own model, so this edits in place and the profile's Save writes all of them
 * at once — the same shape as the customer profile's contacts editor.
 *
 * The state chip is the booking gate's own verdict (`insuranceState`), so what somebody
 * sees here is exactly what `BOOK_CARRIER` will say about this policy.
 */
import { Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { insuranceState } from '@/lib/carrierEligibility'
import { formatCents, parseCents } from '@/lib/tmsDirectory'
import { cn } from '@/lib/utils'
import { INSURANCE_STATE_STYLES } from '../carrierViews'
import type { InsurancePolicy, InsurancePolicyType } from '@/types/tms'

const POLICY_TYPES: InsurancePolicyType[] = ['AUTO_LIABILITY', 'CARGO', 'GENERAL_LIABILITY', 'WORKERS_COMP', 'OTHER']

const POLICY_TYPE_LABELS: Record<InsurancePolicyType, string> = {
  AUTO_LIABILITY: 'Auto liability',
  CARGO: 'Cargo',
  GENERAL_LIABILITY: 'General liability',
  WORKERS_COMP: 'Workers comp',
  OTHER: 'Other',
}

interface InsurancePoliciesEditorProps {
  policies: InsurancePolicy[]
  warnDays: number
  now: string
  onChange: (policies: InsurancePolicy[]) => void
  disabled?: boolean
}

export function InsurancePoliciesEditor({ policies, warnDays, now, onChange, disabled }: InsurancePoliciesEditorProps) {
  const update = (id: string, patch: Partial<InsurancePolicy>) => {
    onChange(policies.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  // Money is typed in dollars and stored in cents; an unparseable amount leaves the
  // stored value alone rather than silently writing a zero.
  const setCents = (id: string, key: 'limitCents' | 'deductibleCents', text: string) => {
    try {
      update(id, { [key]: parseCents(text) })
    } catch {
      /* keep the last valid amount until the text parses */
    }
  }

  return (
    <div className="space-y-3">
      {policies.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No certificates on file. Cargo and auto liability are both required to book this carrier.
        </p>
      )}

      {policies.map((policy) => {
        const state = insuranceState(policy, now, warnDays)
        return (
          <div key={policy.id} className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <select
                aria-label="Policy type"
                value={policy.type}
                disabled={disabled}
                onChange={(e) => update(policy.id, { type: e.target.value as InsurancePolicyType })}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {POLICY_TYPES.map((t) => <option key={t} value={t}>{POLICY_TYPE_LABELS[t]}</option>)}
              </select>
              <Badge variant="secondary" className={cn('text-[10px]', INSURANCE_STATE_STYLES[state])}>
                {state.toLowerCase()}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-8 w-8"
                aria-label={`Remove ${POLICY_TYPE_LABELS[policy.type]} policy`}
                disabled={disabled}
                onClick={() => onChange(policies.filter((p) => p.id !== policy.id))}
              >
                <Trash2 size={14} />
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-3">
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Insurer</Label>
                <Input
                  aria-label="Insurer"
                  value={policy.company ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { company: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Policy #</Label>
                <Input
                  aria-label="Policy number"
                  value={policy.policyNumber ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { policyNumber: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Limit ($)</Label>
                <Input
                  aria-label="Limit"
                  defaultValue={policy.limitCents == null ? '' : formatCents(policy.limitCents)}
                  disabled={disabled}
                  onChange={(e) => setCents(policy.id, 'limitCents', e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Deductible ($)</Label>
                <Input
                  aria-label="Deductible"
                  defaultValue={policy.deductibleCents == null ? '' : formatCents(policy.deductibleCents)}
                  disabled={disabled}
                  onChange={(e) => setCents(policy.id, 'deductibleCents', e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-3">
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Effective</Label>
                <Input
                  aria-label="Effective"
                  type="date"
                  value={(policy.effectiveAt ?? '').slice(0, 10)}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, {
                    effectiveAt: e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : null,
                  })}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Expires</Label>
                <Input
                  aria-label="Expires"
                  type="date"
                  value={(policy.expiresAt ?? '').slice(0, 10)}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, {
                    expiresAt: e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : null,
                  })}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Agent</Label>
                <Input
                  aria-label="Agent"
                  value={policy.agentName ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { agentName: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Agent phone</Label>
                <Input
                  aria-label="Agent phone"
                  value={policy.agentPhone ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { agentPhone: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>
            </div>

            <div className="mt-3">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Exclusions</Label>
              <Textarea
                aria-label="Exclusions"
                value={policy.exclusions ?? ''}
                disabled={disabled}
                onChange={(e) => update(policy.id, { exclusions: e.target.value })}
                className="text-sm"
              />
            </div>
          </div>
        )
      })}

      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...policies, { id: crypto.randomUUID(), type: 'CARGO' }])}
      >
        <Plus size={14} className="mr-1" /> Add policy
      </Button>
    </div>
  )
}
