import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import type { CustomerContact, CustomerContactType, CustomerNotification } from '@/types/tms'
import { cn } from '@/lib/utils'

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
    <div className="space-y-3">
      {contacts.length === 0 && (
        <p className="text-xs text-muted-foreground">No contacts yet.</p>
      )}
      {contacts.map((c) => {
        const open = expanded[c.id] ?? true
        return (
          <div key={c.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setExpanded((p) => ({ ...p, [c.id]: !open }))}
                className="flex-1 text-left text-sm font-medium"
              >
                {c.name || 'New contact'}
                {c.types.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">{c.types.join(', ')}</span>
                )}
              </button>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Switch
                    checked={c.active}
                    onCheckedChange={(checked) => update(c.id, { active: checked })}
                    disabled={disabled}
                  />
                  Active
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => remove(c.id)}
                  disabled={disabled}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
            {open && (
              <div className="mt-3 grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
                    <Input
                      value={c.name}
                      onChange={(e) => update(c.id, { name: e.target.value })}
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Title</Label>
                    <Input
                      value={c.title ?? ''}
                      onChange={(e) => update(c.id, { title: e.target.value })}
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Email</Label>
                    <Input
                      value={c.email ?? ''}
                      onChange={(e) => update(c.id, { email: e.target.value })}
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Phone</Label>
                    <Input
                      value={c.phone ?? ''}
                      onChange={(e) => update(c.id, { phone: e.target.value })}
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 block">Types</Label>
                  <div className="flex flex-wrap gap-2">
                    {CONTACT_TYPES.map((type) => (
                      <label
                        key={type}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer',
                          c.types.includes(type)
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground'
                        )}
                      >
                        <Checkbox
                          checked={c.types.includes(type)}
                          onCheckedChange={() => toggleType(c.id, type)}
                          disabled={disabled}
                        />
                        {type}
                      </label>
                    ))}
                  </div>
                </div>
                {c.types.includes('BILLING') && billToPartyIds.length > 0 && (
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Linked bill-to</Label>
                    <select
                      value={c.billToId ?? ''}
                      onChange={(e) => update(c.id, { billToId: e.target.value || null })}
                      disabled={disabled}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">— none —</option>
                      {billToPartyIds.map((id) => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 block">Notifications</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {NOTIFICATIONS.map((n) => (
                      <label key={n} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={c.notifications.includes(n)}
                          onCheckedChange={() => toggleNotification(c.id, n)}
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
        )
      })}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} className="mr-1" /> Add contact
      </Button>
    </div>
  )
}
