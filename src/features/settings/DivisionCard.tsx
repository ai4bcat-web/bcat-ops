/**
 * The Phase-1 division keys: the legal / remit-to identities an invoice is raised under.
 *
 * Step R introduced `OwnershipDivision` — the editable tree that tags every shipment
 * with the business that owns it, on My Brokerage → Divisions & ownership. These rows
 * are a different, older thing: the `Division` record carries the MC/DOT/SCAC and the
 * remit-to block printed on paperwork, and existing loads still reference it by key.
 * It is labelled "Legacy division keys" so nobody edits it expecting the sidebar or a
 * dashboard grouping to change.
 */
import { useEffect, useState } from 'react'
import { Plus, Pencil, Save, X, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsField, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { listDivisions, saveDivision } from '@/lib/apiClient'
import type { Division } from '@/types/tms'
import { CheckRow, Loading, Panel, SettingsCard, Stack } from './settingsKit'

const FLEET_OPTIONS: { value: NonNullable<Division['fleetGroup']>; label: string }[] = [
  { value: 'LOCAL', label: 'Local' },
  { value: 'AMAZON', label: 'Amazon' },
  { value: 'BOX_TRUCK', label: 'Box truck' },
]

function emptyDivision(): Division {
  return {
    id: '', key: '', name: '', legalName: null, mcNumber: null, dotNumber: null, scac: null,
    remitToName: null, remitToAddress: null, remitToEmail: null, invoicePrefix: null,
    fleetGroup: null, active: true, createdAt: '', updatedAt: '',
  }
}

export function DivisionCard() {
  const [divisions, setDivisions] = useState<Division[]>([])
  const [loading, setLoading] = useState(true)
  // 'new' keeps the form open for a create; null closes it. (Gating on a Division object
  // alone made "Add division" a no-op.)
  const [editing, setEditing] = useState<Division | 'new' | null>(null)
  const [form, setForm] = useState<Division>(() => emptyDivision())

  // State is written only inside the promise chain (react-hooks/set-state-in-effect).
  useEffect(() => {
    listDivisions()
      .then(setDivisions)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load divisions'))
      .finally(() => setLoading(false))
  }, [])

  const set = <K extends keyof Division>(k: K, v: Division[K]) => setForm((p) => ({ ...p, [k]: v }))

  const save = async () => {
    if (!form.key.trim() || !form.name.trim()) { toast.error('Key and name are required'); return }
    try {
      const saved = await saveDivision(form, editing === 'new' ? undefined : editing?.updatedAt)
      setDivisions((prev) => {
        const idx = prev.findIndex((d) => d.id === saved.id)
        if (idx >= 0) return prev.map((d, i) => i === idx ? saved : d)
        return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name))
      })
      setEditing(null)
      setForm(emptyDivision())
      toast.success('Division saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save division') }
  }

  return (
    <SettingsCard
      icon={Building2}
      title="Legacy division keys"
      description="The legal and remit-to identity an invoice is raised under. Shipment ownership — which business a shipment belongs to — is edited under Divisions & ownership; these keys are only the paperwork. Leave unknown fields empty."
      actions={
        <TmsButton size="sm" onClick={() => { setEditing('new'); setForm(emptyDivision()) }}>
          <Plus size={14} /> Add division
        </TmsButton>
      }
    >
      <Stack>
        {editing && (
          <Panel>
            <div className="tms-grid tms-grid-2">
              <TmsField label="Key *">
                <TmsInput value={form.key} onChange={(e) => set('key', e.target.value)} placeholder="BCAT_LOGISTICS" />
              </TmsField>
              <TmsField label="Name *">
                <TmsInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="BCAT Logistics" />
              </TmsField>
              <TmsField label="Legal name">
                <TmsInput value={form.legalName ?? ''} onChange={(e) => set('legalName', e.target.value || null)} />
              </TmsField>
              <TmsField label="Fleet group">
                <TmsSelect
                  value={form.fleetGroup ?? ''}
                  onChange={(e) => set('fleetGroup', (e.target.value || null) as Division['fleetGroup'])}
                >
                  <option value="">— unset —</option>
                  {FLEET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </TmsSelect>
              </TmsField>
              <TmsField label="MC #">
                <TmsInput value={form.mcNumber ?? ''} onChange={(e) => set('mcNumber', e.target.value || null)} />
              </TmsField>
              <TmsField label="DOT #">
                <TmsInput value={form.dotNumber ?? ''} onChange={(e) => set('dotNumber', e.target.value || null)} />
              </TmsField>
              <TmsField label="SCAC">
                <TmsInput value={form.scac ?? ''} onChange={(e) => set('scac', e.target.value || null)} />
              </TmsField>
              <TmsField label="Invoice prefix">
                <TmsInput value={form.invoicePrefix ?? ''} onChange={(e) => set('invoicePrefix', e.target.value || null)} placeholder="BL" />
              </TmsField>
            </div>

            <TmsField label="Remit-to name">
              <TmsInput value={form.remitToName ?? ''} onChange={(e) => set('remitToName', e.target.value || null)} />
            </TmsField>
            <TmsField label="Remit-to email">
              <TmsInput value={form.remitToEmail ?? ''} onChange={(e) => set('remitToEmail', e.target.value || null)} />
            </TmsField>

            <TmsField label="Remit-to address">
              <div className="tms-grid tms-grid-2">
                <TmsInput aria-label="Remit-to street" value={form.remitToAddress?.street ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, street: e.target.value || null })} placeholder="Street" />
                <TmsInput aria-label="Remit-to city" value={form.remitToAddress?.city ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, city: e.target.value || null })} placeholder="City" />
                <TmsInput aria-label="Remit-to state" value={form.remitToAddress?.state ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, state: e.target.value || null })} placeholder="State" />
                <TmsInput aria-label="Remit-to ZIP" value={form.remitToAddress?.zip ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, zip: e.target.value || null })} placeholder="ZIP" />
                <TmsInput aria-label="Remit-to country" value={form.remitToAddress?.country ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, country: e.target.value || null })} placeholder="Country" />
              </div>
            </TmsField>

            <CheckRow label="Active" ariaLabel="Division active" checked={form.active} onChange={(v) => set('active', v)} />

            <div style={{ display: 'flex', gap: 8 }}>
              <TmsButton variant="primary" size="sm" onClick={save}><Save size={14} /> Save</TmsButton>
              <TmsButton size="sm" onClick={() => setEditing(null)}><X size={14} /> Cancel</TmsButton>
            </div>
          </Panel>
        )}

        {loading ? <Loading /> : (
          <Stack gap={8}>
            {divisions.slice().sort((a, b) => a.name.localeCompare(b.name)).map((d) => (
              <div
                key={d.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  border: '1px solid var(--tms-border)', borderRadius: 'var(--tms-radius)', padding: '6px 10px', fontSize: 14,
                }}
              >
                <div>
                  <span style={{ fontWeight: 500 }}>{d.name}</span>
                  <span className="tms-muted" style={{ marginLeft: 8 }}>{d.key}</span>
                  {d.active === false && <span className="tms-muted" style={{ marginLeft: 8, fontSize: 12 }}>(inactive)</span>}
                </div>
                <TmsIconButton
                  shape="plain"
                  aria-label={`Edit ${d.name}`}
                  onClick={() => { setEditing(d); setForm({ ...d }) }}
                >
                  <Pencil size={14} />
                </TmsIconButton>
              </div>
            ))}
          </Stack>
        )}
      </Stack>
    </SettingsCard>
  )
}
