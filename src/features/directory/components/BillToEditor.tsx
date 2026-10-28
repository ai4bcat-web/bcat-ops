import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
    <div className="space-y-3">
      {parties.length === 0 && <p className="text-xs text-muted-foreground">No bill-to parties yet.</p>}
      {parties.map((p) => {
        const open = expanded[p.id] ?? true
        return (
          <div key={p.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !open }))}
                className="flex-1 text-left text-sm font-medium"
              >
                {p.name || 'New bill-to'}
                {p.isDefault && <span className="ml-2 text-xs text-primary">default</span>}
              </button>
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Switch checked={p.isDefault} onCheckedChange={() => setDefault(p.id)} disabled={disabled} />
                Default
              </Label>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(p.id)} disabled={disabled}>
                <Trash2 size={14} />
              </Button>
            </div>
            {open && (
              <div className="mt-3 grid gap-3">
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
                  <Input value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} disabled={disabled} className="h-9 text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Email</Label>
                    <Input value={p.email ?? ''} onChange={(e) => update(p.id, { email: e.target.value })} disabled={disabled} className="h-9 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">Phone</Label>
                    <Input value={p.phone ?? ''} onChange={(e) => update(p.id, { phone: e.target.value })} disabled={disabled} className="h-9 text-sm" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Payment terms (days)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={p.paymentTermsDays ?? ''}
                    onChange={(e) => update(p.id, { paymentTermsDays: e.target.value ? Number(e.target.value) : null })}
                    disabled={disabled}
                    className="h-9 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Address</Label>
                  <div className="mt-1 grid grid-cols-2 gap-3">
                    <Input
                      value={p.address?.street ?? ''}
                      onChange={(e) => update(p.id, { address: { ...p.address, street: e.target.value || null } })}
                      placeholder="Street"
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                    <Input
                      value={p.address?.city ?? ''}
                      onChange={(e) => update(p.id, { address: { ...p.address, city: e.target.value || null } })}
                      placeholder="City"
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                    <Input
                      value={p.address?.state ?? ''}
                      onChange={(e) => update(p.id, { address: { ...p.address, state: e.target.value || null } })}
                      placeholder="State"
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                    <Input
                      value={p.address?.zip ?? ''}
                      onChange={(e) => update(p.id, { address: { ...p.address, zip: e.target.value || null } })}
                      placeholder="ZIP"
                      disabled={disabled}
                      className="h-9 text-sm"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} className="mr-1" /> Add bill-to
      </Button>
    </div>
  )
}
