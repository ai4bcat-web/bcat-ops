/** Customers that override the automation policy or the check-call plan, edited inline. */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { useDirectory } from '@/hooks/useDirectory'
import type { AutomationPolicy, AutomationPolicyPatch } from '@/lib/trackingAutomation'
import type { CustomerRecord } from '@/types/tms'
import { ErrorText, Hint, Loading, Panel } from '../settingsKit'
import { overrideCount, patchProblems } from './policyPatch'
import { TrackingAutomationEditor } from './TrackingAutomationEditor'

export interface CustomersPanelProps {
  /** Policy a customer inherits (defaults + global; division overrides apply per shipment). */
  inherited: AutomationPolicy
}

export function CustomersPanel({ inherited }: CustomersPanelProps) {
  const { customers, loading, error, saveCustomer } = useDirectory()
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AutomationPolicyPatch>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const overridden = useMemo(
    () => customers.filter((c) => overrideCount(c.trackingAutomation) > 0 || !!c.checkCallPlan),
    [customers],
  )
  const q = search.trim().toLowerCase()
  const shown = overridden.filter((c) => !q || c.name.toLowerCase().includes(q))
  const addable = customers.filter((c) => !overridden.some((o) => o.id === c.id))
  const editing = customers.find((c) => c.id === editingId) ?? null

  if (loading) return <Loading />

  const open = (customer: CustomerRecord) => {
    setEditingId(customer.id)
    setDraft(customer.trackingAutomation ?? {})
    setSaveError(null)
  }
  const problems = patchProblems(draft, inherited)

  const save = async (customer: CustomerRecord) => {
    setSaving(true)
    setSaveError(null)
    try {
      await saveCustomer(customer, { trackingAutomation: overrideCount(draft) ? draft : null })
      toast.success(`${customer.name} automation saved`)
      setEditingId(null)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the customer')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Hint>Customer overrides beat division and default settings, field by field. The check-call plan itself is edited on the customer's profile.</Hint>
      {error && <ErrorText>{error}</ErrorText>}
      <div style={{ display: 'flex', gap: 8 }}>
        <TmsInput aria-label="Search customers" placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <TmsSelect
          aria-label="Add override"
          value=""
          placeholder="Add override…"
          onChange={(e) => { const c = customers.find((x) => x.id === e.target.value); if (c) open(c) }}
          options={addable.map((c) => ({ value: c.id, label: c.name }))}
        />
      </div>
      {editing && !overridden.some((c) => c.id === editing.id) && (
        <CustomerEditor customer={editing} draft={draft} setDraft={setDraft} inherited={inherited} problems={problems} saving={saving} saveError={saveError} onSave={save} onCancel={() => setEditingId(null)} />
      )}
      {shown.length === 0 && !editing && <p className="tms-muted tms-flush">No customers override the automation settings.</p>}
      {shown.map((customer) => {
        const n = overrideCount(customer.trackingAutomation)
        return (
          <Panel key={customer.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} data-testid={`customer-override-${customer.id}`}>
              <strong style={{ flex: 1 }}>{customer.name}</strong>
              {n > 0 && <TmsBadge tone="blue">{`Policy · ${n} ${n === 1 ? 'field' : 'fields'}`}</TmsBadge>}
              {customer.checkCallPlan && <TmsBadge tone="purple">Own plan</TmsBadge>}
              <Link className="tms-link" to={`/tms/customers?customer=${customer.id}`}>Open profile</Link>
              <TmsButton size="sm" onClick={() => (editingId === customer.id ? setEditingId(null) : open(customer))}>
                {editingId === customer.id ? 'Close' : 'Edit'}
              </TmsButton>
            </div>
            {editingId === customer.id && (
              <CustomerEditor customer={customer} draft={draft} setDraft={setDraft} inherited={inherited} problems={problems} saving={saving} saveError={saveError} onSave={save} onCancel={() => setEditingId(null)} />
            )}
          </Panel>
        )
      })}
    </div>
  )
}

function CustomerEditor({
  customer, draft, setDraft, inherited, problems, saving, saveError, onSave, onCancel,
}: {
  customer: CustomerRecord
  draft: AutomationPolicyPatch
  setDraft: (next: AutomationPolicyPatch) => void
  inherited: AutomationPolicy
  problems: string[]
  saving: boolean
  saveError: string | null
  onSave: (customer: CustomerRecord) => void
  onCancel: () => void
}) {
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      <TrackingAutomationEditor scope="CUSTOMER" value={draft} inherited={inherited} onChange={setDraft} />
      {problems.map((p) => <ErrorText key={p}>{p}</ErrorText>)}
      {saveError && <ErrorText>{saveError}</ErrorText>}
      <div style={{ display: 'flex', gap: 8 }}>
        <TmsButton variant="primary" size="sm" disabled={saving || problems.length > 0} onClick={() => onSave(customer)}>
          Save {customer.name}
        </TmsButton>
        <TmsButton size="sm" onClick={onCancel}>Cancel</TmsButton>
      </div>
    </div>
  )
}
