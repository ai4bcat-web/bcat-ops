import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsField, TmsInput } from '@/features/tms/kit'
import type { BillToParty } from '@/types/tms'

function emptyParty(): BillToParty {
  return { id: crypto.randomUUID(), name: '', address: {}, isDefault: false }
}

interface BillToEditorProps {
  parties: BillToParty[]
  onChange: (parties: BillToParty[]) => void
  disabled?: boolean
}

export function BillToEditor({ parties, onChange, disabled }: BillToEditorProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const update = (id: string, patch: Partial<BillToParty>) => {
    onChange(parties.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const setDefault = (id: string) => {
    onChange(parties.map((p) => ({ ...p, isDefault: p.id === id })))
  }

  const add = () => {
    const p = emptyParty()
    onChange([...parties, p])
    setExpanded((prev) => ({ ...prev, [p.id]: true }))
  }

  const remove = (id: string) => onChange(parties.filter((p) => p.id !== id))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {parties.length === 0 && <p className="tms-muted" style={{ fontSize: 12 }}>No bill-to parties yet.</p>}
      {parties.map((p) => {
        const open = expanded[p.id] ?? true
        return (
          <div key={p.id} className="tms-card">
            <div className="tms-card-body" style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !open }))}
                  style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: 0 }}
                >
                  {p.name || 'New bill-to'}
                  {p.isDefault && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--tms-primary)' }}>default</span>}
                </button>
                <label className="tms-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={p.isDefault} onChange={() => setDefault(p.id)} disabled={disabled} />
                  Default
                </label>
                <TmsButton variant="ghost" size="sm" aria-label="Remove bill-to" onClick={() => remove(p.id)} disabled={disabled}>
                  <Trash2 size={14} />
                </TmsButton>
              </div>
              {open && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <TmsField label="Name">
                    <TmsInput value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} disabled={disabled} />
                  </TmsField>
                  <div className="tms-grid tms-grid-2">
                    <TmsField label="Email">
                      <TmsInput value={p.email ?? ''} onChange={(e) => update(p.id, { email: e.target.value })} disabled={disabled} />
                    </TmsField>
                    <TmsField label="Phone">
                      <TmsInput value={p.phone ?? ''} onChange={(e) => update(p.id, { phone: e.target.value })} disabled={disabled} />
                    </TmsField>
                  </div>
                  <TmsField label="Payment terms (days)">
                    <TmsInput
                      type="number"
                      min={0}
                      value={p.paymentTermsDays ?? ''}
                      onChange={(e) => update(p.id, { paymentTermsDays: e.target.value ? Number(e.target.value) : null })}
                      disabled={disabled}
                    />
                  </TmsField>
                  <div>
                    <div className="tms-field-label" style={{ marginBottom: 6 }}>Address</div>
                    <div className="tms-grid tms-grid-2">
                      <TmsInput
                        value={p.address?.street ?? ''}
                        onChange={(e) => update(p.id, { address: { ...p.address, street: e.target.value || null } })}
                        placeholder="Street"
                        disabled={disabled}
                      />
                      <TmsInput
                        value={p.address?.city ?? ''}
                        onChange={(e) => update(p.id, { address: { ...p.address, city: e.target.value || null } })}
                        placeholder="City"
                        disabled={disabled}
                      />
                      <TmsInput
                        value={p.address?.state ?? ''}
                        onChange={(e) => update(p.id, { address: { ...p.address, state: e.target.value || null } })}
                        placeholder="State"
                        disabled={disabled}
                      />
                      <TmsInput
                        value={p.address?.zip ?? ''}
                        onChange={(e) => update(p.id, { address: { ...p.address, zip: e.target.value || null } })}
                        placeholder="ZIP"
                        disabled={disabled}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
      <TmsButton size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} /> Add bill-to
      </TmsButton>
    </div>
  )
}
