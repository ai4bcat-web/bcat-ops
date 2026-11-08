import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { CustomerContact, CustomerContactType, CustomerNotification } from '@/types/tms'

const CONTACT_TYPES: CustomerContactType[] = ['PRIMARY', 'BILLING', 'OPERATIONS', 'SALES', 'CLAIMS', 'OTHER']
const NOTIFICATIONS: CustomerNotification[] = [
  'APPT_SCHEDULED',
  'LOADING',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'UNLOADING',
  'DELIVERED',
  'INVOICE_SENT',
]

const notificationLabels: Record<CustomerNotification, string> = {
  APPT_SCHEDULED: 'Appt scheduled',
  LOADING: 'Loading',
  PICKED_UP: 'Picked up',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  UNLOADING: 'Unloading',
  DELIVERED: 'Delivered',
  INVOICE_SENT: 'Invoice sent',
}

function emptyContact(): CustomerContact {
  return { id: crypto.randomUUID(), name: '', types: [], notifications: [], active: true }
}

interface ContactsEditorProps {
  contacts: CustomerContact[]
  billToPartyIds?: string[]
  onChange: (contacts: CustomerContact[]) => void
  disabled?: boolean
}

export function ContactsEditor({ contacts, billToPartyIds = [], onChange, disabled }: ContactsEditorProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const update = (id: string, patch: Partial<CustomerContact>) => {
    onChange(contacts.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }

  const toggleType = (id: string, type: CustomerContactType) => {
    const c = contacts.find((x) => x.id === id)
    if (!c) return
    const set = new Set(c.types)
    if (set.has(type)) set.delete(type)
    else set.add(type)
    update(id, { types: Array.from(set) })
  }

  const toggleNotification = (id: string, n: CustomerNotification) => {
    const c = contacts.find((x) => x.id === id)
    if (!c) return
    const set = new Set(c.notifications)
    if (set.has(n)) set.delete(n)
    else set.add(n)
    update(id, { notifications: Array.from(set) })
  }

  const add = () => {
    const c = emptyContact()
    onChange([...contacts, c])
    setExpanded((p) => ({ ...p, [c.id]: true }))
  }

  const remove = (id: string) => onChange(contacts.filter((c) => c.id !== id))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {contacts.length === 0 && <p className="tms-muted" style={{ fontSize: 12 }}>No contacts yet.</p>}
      {contacts.map((c) => {
        const open = expanded[c.id] ?? true
        return (
          <div key={c.id} className="tms-card">
            <div className="tms-card-body" style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setExpanded((p) => ({ ...p, [c.id]: !open }))}
                  style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer', padding: 0 }}
                >
                  {c.name || 'New contact'}
                  {c.types.length > 0 && <span className="tms-muted" style={{ marginLeft: 8, fontSize: 12 }}>{c.types.join(', ')}</span>}
                </button>
                <label className="tms-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={c.active}
                    onChange={(e) => update(c.id, { active: e.target.checked })}
                    disabled={disabled}
                  />
                  Active
                </label>
                <TmsButton variant="ghost" size="sm" aria-label="Remove contact" onClick={() => remove(c.id)} disabled={disabled}>
                  <Trash2 size={14} />
                </TmsButton>
              </div>
              {open && (
                <div style={{ display: 'grid', gap: 12 }}>
                  <div className="tms-grid tms-grid-2">
                    <TmsField label="Name">
                      <TmsInput value={c.name} onChange={(e) => update(c.id, { name: e.target.value })} disabled={disabled} />
                    </TmsField>
                    <TmsField label="Title">
                      <TmsInput value={c.title ?? ''} onChange={(e) => update(c.id, { title: e.target.value })} disabled={disabled} />
                    </TmsField>
                    <TmsField label="Email">
                      <TmsInput value={c.email ?? ''} onChange={(e) => update(c.id, { email: e.target.value })} disabled={disabled} />
                    </TmsField>
                    <TmsField label="Phone">
                      <TmsInput value={c.phone ?? ''} onChange={(e) => update(c.id, { phone: e.target.value })} disabled={disabled} />
                    </TmsField>
                  </div>
                  <div>
                    <div className="tms-field-label" style={{ marginBottom: 6 }}>Types</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {CONTACT_TYPES.map((type) => (
                        <label
                          key={type}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer',
                            borderRadius: 4, padding: '3px 8px',
                            border: `1px solid ${c.types.includes(type) ? 'var(--tms-primary)' : 'var(--tms-border)'}`,
                            color: c.types.includes(type) ? 'var(--tms-primary)' : 'var(--tms-muted)',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={c.types.includes(type)}
                            onChange={() => toggleType(c.id, type)}
                            disabled={disabled}
                          />
                          {type}
                        </label>
                      ))}
                    </div>
                  </div>
                  {c.types.includes('BILLING') && billToPartyIds.length > 0 && (
                    <TmsField label="Linked bill-to">
                      <TmsSelect
                        value={c.billToId ?? ''}
                        onChange={(e) => update(c.id, { billToId: e.target.value || null })}
                        disabled={disabled}
                        placeholder="— none —"
                        options={billToPartyIds.map((id) => ({ value: id, label: id }))}
                      />
                    </TmsField>
                  )}
                  <div>
                    <div className="tms-field-label" style={{ marginBottom: 6 }}>Notifications</div>
                    <div className="tms-grid tms-grid-2">
                      {NOTIFICATIONS.map((n) => (
                        <label key={n} className="tms-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            checked={c.notifications.includes(n)}
                            onChange={() => toggleNotification(c.id, n)}
                            disabled={disabled}
                          />
                          {notificationLabels[n]}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
      <TmsButton size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} /> Add contact
      </TmsButton>
    </div>
  )
}
