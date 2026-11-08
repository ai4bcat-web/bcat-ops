/**
 * The carrier's certificates of insurance. These are a JSON array on the carrier row,
 * not their own model, so this edits in place and the profile's Save writes all of them
 * at once — the same shape as the customer profile's contacts editor.
 *
 * The state chip is the booking gate's own verdict (`insuranceState`), so what somebody
 * sees here is exactly what `BOOK_CARRIER` will say about this policy.
 */
import { Plus, Trash2 } from 'lucide-react'
import { TmsBadge, TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { insuranceState } from '@/lib/carrierEligibility'
import { formatCents, parseCents } from '@/lib/tmsDirectory'
import { INSURANCE_STATE_TONE } from '../carrierViews'
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
    <div className="flex flex-col gap-3">
      {policies.length === 0 && (
        <p className="tms-muted">
          No certificates on file. Cargo and auto liability are both required to book this carrier.
        </p>
      )}

      {policies.map((policy) => {
        const state = insuranceState(policy, now, warnDays)
        return (
          <div
            key={policy.id}
            className="p-3"
            style={{ border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)' }}
          >
            <div className="flex items-center gap-2">
              <TmsSelect
                aria-label="Policy type"
                value={policy.type}
                disabled={disabled}
                onChange={(e) => update(policy.id, { type: e.target.value as InsurancePolicyType })}
                className="w-auto"
              >
                {POLICY_TYPES.map((t) => <option key={t} value={t}>{POLICY_TYPE_LABELS[t]}</option>)}
              </TmsSelect>
              <TmsBadge tone={INSURANCE_STATE_TONE[state]}>{state.toLowerCase()}</TmsBadge>
              <TmsIconButton
                className="ml-auto"
                aria-label={`Remove ${POLICY_TYPE_LABELS[policy.type]} policy`}
                disabled={disabled}
                onClick={() => onChange(policies.filter((p) => p.id !== policy.id))}
              >
                <Trash2 size={14} />
              </TmsIconButton>
            </div>

            <div className="tms-grid tms-grid-4 mt-3">
              <TmsField label="Insurer">
                <TmsInput
                  aria-label="Insurer"
                  value={policy.company ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { company: e.target.value })}
                />
              </TmsField>
              <TmsField label="Policy #">
                <TmsInput
                  aria-label="Policy number"
                  value={policy.policyNumber ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { policyNumber: e.target.value })}
                />
              </TmsField>
              <TmsField label="Limit ($)">
                <TmsInput
                  aria-label="Limit"
                  defaultValue={policy.limitCents == null ? '' : formatCents(policy.limitCents)}
                  disabled={disabled}
                  onChange={(e) => setCents(policy.id, 'limitCents', e.target.value)}
                />
              </TmsField>
              <TmsField label="Deductible ($)">
                <TmsInput
                  aria-label="Deductible"
                  defaultValue={policy.deductibleCents == null ? '' : formatCents(policy.deductibleCents)}
                  disabled={disabled}
                  onChange={(e) => setCents(policy.id, 'deductibleCents', e.target.value)}
                />
              </TmsField>
            </div>

            <div className="tms-grid tms-grid-4 mt-3">
              <TmsField label="Effective">
                <TmsInput
                  aria-label="Effective"
                  type="date"
                  value={(policy.effectiveAt ?? '').slice(0, 10)}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, {
                    effectiveAt: e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : null,
                  })}
                />
              </TmsField>
              <TmsField label="Expires">
                <TmsInput
                  aria-label="Expires"
                  type="date"
                  value={(policy.expiresAt ?? '').slice(0, 10)}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, {
                    expiresAt: e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : null,
                  })}
                />
              </TmsField>
              <TmsField label="Agent">
                <TmsInput
                  aria-label="Agent"
                  value={policy.agentName ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { agentName: e.target.value })}
                />
              </TmsField>
              <TmsField label="Agent phone">
                <TmsInput
                  aria-label="Agent phone"
                  value={policy.agentPhone ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { agentPhone: e.target.value })}
                />
              </TmsField>
            </div>

            <div className="mt-3">
              <TmsField label="Exclusions">
                <TmsTextarea
                  aria-label="Exclusions"
                  value={policy.exclusions ?? ''}
                  disabled={disabled}
                  onChange={(e) => update(policy.id, { exclusions: e.target.value })}
                />
              </TmsField>
            </div>
          </div>
        )
      })}

      <div>
        <TmsButton
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...policies, { id: crypto.randomUUID(), type: 'CARGO' }])}
        >
          <Plus size={14} /> Add policy
        </TmsButton>
      </div>
    </div>
  )
}
