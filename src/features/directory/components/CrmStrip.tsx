import { useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsIconButton, TmsInput } from '@/features/tms/kit'
import type { TmsTone } from '@/features/tms/kit'
import type { CrmAccountView } from '@/lib/crm/types'
import { dateInputToIso, isOverdue, isoToDateInput, kindLabel, relativeDay } from '@/features/crm/format'
import type { CustomerRecord } from '@/types/tms'

interface CrmStripProps {
  customer: CustomerRecord
  view: CrmAccountView | null
  loading: boolean
  error: string | null
  isManager: boolean
  onSetNextStep: (nextStep: string, dueAt?: string) => Promise<unknown>
  onReleaseDomain: (domain: string) => Promise<unknown>
  tone: TmsTone | undefined
}

/**
 * Account strip on the customer card: owner · stage · last touch · next step (inline edit),
 * the first-shipment promotion note and the domains this account holds. When the viewer may
 * not see CRM detail (§5.6) it says so and offers nothing to edit.
 */
export function CrmStrip({ customer, view, loading, error, isManager, onSetNextStep, onReleaseDomain, tone }: CrmStripProps) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [saving, setSaving] = useState(false)

  if (loading && !view) return <div className="tms-muted" data-testid="crm-strip" style={{ fontSize: 13 }}>Loading CRM…</div>
  if (error && !view) return <div className="tms-field-error" data-testid="crm-strip">{error}</div>
  if (!view) return null
  if (!view.visible) {
    return (
      <div className="tms-muted" data-testid="crm-strip" style={{ fontSize: 13 }}>
        CRM activity for this account is visible to its owner and to managers.
      </div>
    )
  }

  const account = view.account
  const lastTouchAt = [account?.lastTouchAt, view.derived.lastTouchAt].filter(Boolean).sort().pop() ?? null
  const overdue = isOverdue(account?.nextStepDueAt)
  const promoted = customer.statusReason === 'FIRST_SHIPMENT'

  const startEdit = () => {
    setText(account?.nextStep ?? '')
    setDue(isoToDateInput(account?.nextStepDueAt))
    setEditing(true)
  }
  const save = async () => {
    setSaving(true)
    try {
      await onSetNextStep(text.trim(), dateInputToIso(due))
      setEditing(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save next step')
    } finally {
      setSaving(false)
    }
  }
  const release = async (domain: string) => {
    try { await onReleaseDomain(domain) } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not remove domain') }
  }

  return (
    <div data-testid="crm-strip" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, fontSize: 13 }}>
        <span data-testid="crm-owner"><span className="tms-muted">Owner </span>{view.owner?.name ?? view.owner?.email ?? 'Unassigned'}</span>
        <span data-testid="crm-stage">
          <span className="tms-muted">Stage </span>
          {view.stage ? <TmsBadge tone={tone}>{view.stage}</TmsBadge> : '—'}
        </span>
        <span data-testid="crm-last-touch">
          <span className="tms-muted">Last touch </span>
          {lastTouchAt ? `${kindLabel(account?.lastTouchKind)} · ${relativeDay(lastTouchAt)}` : 'none yet'}
        </span>
        <span data-testid="crm-next-step" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="tms-muted">Next step </span>
          {editing ? (
            <>
              <TmsInput value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="What happens next" aria-label="Next step" data-testid="crm-next-step-input" />
              <TmsInput type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Next step due date" data-testid="crm-next-step-due" />
              <TmsButton size="sm" variant="primary" onClick={() => void save()} disabled={saving} data-testid="crm-next-step-save">Save</TmsButton>
              <TmsButton size="sm" onClick={() => setEditing(false)}>Cancel</TmsButton>
            </>
          ) : (
            <>
              {account?.nextStep ? (
                <span data-overdue={overdue ? 'true' : undefined}>
                  {account.nextStep}{account.nextStepDueAt ? ` · due ${isoToDateInput(account.nextStepDueAt)}` : ''}
                  {overdue && <> <TmsBadge tone="red">overdue</TmsBadge></>}
                </span>
              ) : <span className="tms-muted">none</span>}
              <TmsButton size="sm" onClick={startEdit} data-testid="crm-next-step-edit">Edit</TmsButton>
            </>
          )}
        </span>
      </div>
      {promoted && (
        <div className="tms-muted" style={{ fontSize: 12 }} data-testid="crm-promoted">
          Promoted automatically on first shipment{customer.statusChangedAt ? ` · ${customer.statusChangedAt.slice(0, 10)}` : ''}
        </div>
      )}
      {view.domains.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-testid="crm-domains">
          {view.domains.map((d) => (
            <span key={d.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <TmsBadge>{d.id}</TmsBadge>
              {isManager && (
                <TmsIconButton shape="plain" aria-label={`Remove domain ${d.id}`} data-testid={`crm-domain-remove-${d.id}`} onClick={() => void release(d.id)}>
                  <X size={12} />
                </TmsIconButton>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
