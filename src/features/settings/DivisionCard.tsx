import { useEffect, useState } from 'react'
import { Plus, Pencil, Save, X, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { listDivisions, saveDivision } from '@/lib/apiClient'
import type { Division } from '@/types/tms'

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

  const startEdit = (d: Division) => { setEditing(d); setForm({ ...d }) }
  const startNew = () => { setEditing('new'); setForm(emptyDivision()) }

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
    <div style={{ border: '1px solid var(--ds-border)', borderRadius: 12, background: 'var(--ds-surface)', padding: 16, boxShadow: 'var(--sh-sm)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Building2 size={16} style={{ color: 'var(--ds-t3)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)' }}>Divisions</div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>Revenue divisions and legal / remit-to details. Leave unknown fields empty.</div>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1" onClick={startNew}>
          <Plus className="size-3.5" /> Add division
        </Button>
      </div>

      {editing && (
        <div className="border rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Key *</Label>
              <Input value={form.key} onChange={(e) => set('key', e.target.value)} placeholder="BCAT_LOGISTICS" className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name *</Label>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="BCAT Logistics" className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Legal name</Label>
              <Input value={form.legalName ?? ''} onChange={(e) => set('legalName', e.target.value || null)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Fleet group</Label>
              <Select value={form.fleetGroup ?? '__UNSET__'} onValueChange={(v) => set('fleetGroup', (v === '__UNSET__' ? null : v) as Division['fleetGroup'])}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="— unset —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__UNSET__">— unset —</SelectItem>
                  {FLEET_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">MC #</Label>
              <Input value={form.mcNumber ?? ''} onChange={(e) => set('mcNumber', e.target.value || null)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">DOT #</Label>
              <Input value={form.dotNumber ?? ''} onChange={(e) => set('dotNumber', e.target.value || null)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">SCAC</Label>
              <Input value={form.scac ?? ''} onChange={(e) => set('scac', e.target.value || null)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Invoice prefix</Label>
              <Input value={form.invoicePrefix ?? ''} onChange={(e) => set('invoicePrefix', e.target.value || null)} placeholder="BL" className="h-9 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Remit-to name</Label>
            <Input value={form.remitToName ?? ''} onChange={(e) => set('remitToName', e.target.value || null)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Remit-to email</Label>
            <Input value={form.remitToEmail ?? ''} onChange={(e) => set('remitToEmail', e.target.value || null)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Remit-to address</Label>
            <div className="grid grid-cols-2 gap-3 mt-1.5">
              <Input value={form.remitToAddress?.street ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, street: e.target.value || null })} placeholder="Street" className="h-9 text-sm" />
              <Input value={form.remitToAddress?.city ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, city: e.target.value || null })} placeholder="City" className="h-9 text-sm" />
              <Input value={form.remitToAddress?.state ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, state: e.target.value || null })} placeholder="State" className="h-9 text-sm" />
              <Input value={form.remitToAddress?.zip ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, zip: e.target.value || null })} placeholder="ZIP" className="h-9 text-sm" />
              <Input value={form.remitToAddress?.country ?? ''} onChange={(e) => set('remitToAddress', { ...form.remitToAddress, country: e.target.value || null })} placeholder="Country" className="h-9 text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.active} onCheckedChange={(v) => set('active', v)} />
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer">Active</Label>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-8 gap-1" onClick={save}><Save className="size-3.5" /> Save</Button>
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1" onClick={() => setEditing(null)}><X className="size-3.5" /> Cancel</Button>
          </div>
        </div>
      )}

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
        <div className="space-y-2">
          {divisions.sort((a, b) => a.name.localeCompare(b.name)).map((d) => (
            <div key={d.id} className="flex items-center justify-between border rounded-lg p-2 text-sm">
              <div>
                <span className="font-medium">{d.name}</span>
                <span className="text-muted-foreground ml-2">{d.key}</span>
                {d.active === false && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => startEdit(d)}>
                <Pencil className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
