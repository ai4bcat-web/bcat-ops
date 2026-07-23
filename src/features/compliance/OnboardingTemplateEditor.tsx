import { useEffect, useState, type CSSProperties } from 'react'
import {
  ChevronDown, ChevronRight, Plus, Trash2, ArrowUp, ArrowDown, Save, RotateCcw, Eye, EyeOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { getTemplateConfig, saveTemplateConfig, deleteTemplateConfig } from '@/lib/complianceClient'
import { AMAZON_DRIVER_TEMPLATE, type OnboardingTemplate, type TemplateEntry } from '@/lib/onboardingTemplates'
import { getRequirement, ALL_REQUIREMENTS } from '@/lib/complianceRequirements'
import { Card } from './components'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const selCls = 'h-8 rounded-md border border-input bg-white px-2 text-xs'
const chk: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ds-t2)' }

// A driver-owned entry is visible to the driver by default; the flag can override it.
function effectiveVisible(e: TemplateEntry): boolean {
  return e.driverVisible ?? (e.owner === 'DRIVER' && (e.entity ?? 'DRIVER') === 'DRIVER')
}

export function OnboardingTemplateEditor() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<OnboardingTemplate | null>(null)
  const [customized, setCustomized] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const cfg = await getTemplateConfig(AMAZON_DRIVER_TEMPLATE.id)
      setCustomized(!!cfg)
      setDraft(clone(cfg ?? AMAZON_DRIVER_TEMPLATE))
      setDirty(false)
    } catch (e) {
      console.error('[template editor] load error', e)
      setDraft(clone(AMAZON_DRIVER_TEMPLATE))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function mutate(fn: (d: OnboardingTemplate) => void) {
    setDraft((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next)
      return next
    })
    setDirty(true)
  }

  const patchEntry = (pi: number, ei: number, patch: Partial<TemplateEntry>) =>
    mutate((d) => { d.phases[pi].entries[ei] = { ...d.phases[pi].entries[ei], ...patch } })

  const moveEntry = (pi: number, ei: number, dir: -1 | 1) =>
    mutate((d) => {
      const arr = d.phases[pi].entries
      const j = ei + dir
      if (j < 0 || j >= arr.length) return
      ;[arr[ei], arr[j]] = [arr[j], arr[ei]]
    })

  const removeEntry = (pi: number, ei: number) =>
    mutate((d) => { d.phases[pi].entries.splice(ei, 1) })

  const addEntry = (pi: number, key: string) =>
    mutate((d) => {
      const req = getRequirement(key)
      d.phases[pi].entries.push({ key, owner: req?.driverActionable ? 'DRIVER' : 'OFFICE' })
    })

  const addPhase = () =>
    mutate((d) => { d.phases.push({ phase: d.phases.length + 1, title: `Phase ${d.phases.length + 1}`, entries: [] }) })

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      // Renumber phases to be contiguous 1..n before saving.
      const normalized: OnboardingTemplate = { ...draft, phases: draft.phases.map((p, i) => ({ ...p, phase: i + 1 })) }
      await saveTemplateConfig(normalized, user?.email ?? undefined)
      setDraft(clone(normalized))
      setCustomized(true)
      setDirty(false)
      toast.success('Onboarding template saved — new drivers will use this version')
    } catch (e) { console.error(e); toast.error('Could not save template') }
    finally { setSaving(false) }
  }

  async function resetToDefault() {
    setSaving(true)
    try {
      await deleteTemplateConfig(AMAZON_DRIVER_TEMPLATE.id)
      setCustomized(false)
      setDraft(clone(AMAZON_DRIVER_TEMPLATE))
      setDirty(false)
      toast.success('Reset to the built-in default template')
    } catch (e) { console.error(e); toast.error('Could not reset') }
    finally { setSaving(false) }
  }

  return (
    <Card
      title="Onboarding template"
      sub={loading ? 'Loading…' : `${draft?.label ?? 'Amazon'} · edit the steps every new driver sees`}
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge variant={customized ? 'default' : 'secondary'}>{customized ? 'Customized' : 'Default'}</Badge>
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {open ? 'Hide' : 'Edit'}
          </Button>
        </div>
      }
      noPad
    >
      {open && draft && (
        <div style={{ padding: '4px 16px 16px' }}>
          {/* Action bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--ds-border)', marginBottom: 10, flexWrap: 'wrap' }}>
            <Button size="sm" onClick={save} disabled={saving || !dirty}><Save size={14} /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</Button>
            {customized && <Button size="sm" variant="outline" onClick={resetToDefault} disabled={saving}><RotateCcw size={14} /> Reset to default</Button>}
            <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
              Edits apply to <strong>new</strong> drivers you onboard — already-generated checklists aren’t changed.
            </span>
          </div>

          {draft.phases.map((phase, pi) => (
            <div key={pi} style={{ marginBottom: 16, border: '1px solid var(--ds-border)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--ds-bg-2)', borderBottom: '1px solid var(--ds-border)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t3)' }}>PHASE {pi + 1}</span>
                <Input
                  value={phase.title}
                  onChange={(e) => mutate((d) => { d.phases[pi].title = e.target.value })}
                  className="h-8 flex-1"
                  placeholder="Phase title"
                />
              </div>

              <div style={{ padding: '6px 12px' }}>
                {phase.entries.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ds-t3)', padding: '6px 0' }}>No steps yet — add one below.</div>}
                {phase.entries.map((entry, ei) => {
                  const req = getRequirement(entry.key)
                  const visible = effectiveVisible(entry)
                  return (
                    <div key={ei} style={{ padding: '8px 0', borderBottom: '1px solid var(--ds-border)' }}>
                      {/* line 1: label + reorder/remove */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Input
                          value={entry.label ?? ''}
                          onChange={(e) => patchEntry(pi, ei, { label: e.target.value || undefined })}
                          placeholder={req?.label ?? entry.key}
                          className="h-8 flex-1"
                        />
                        <Button size="sm" variant="ghost" onClick={() => moveEntry(pi, ei, -1)} disabled={ei === 0} title="Move up"><ArrowUp size={13} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => moveEntry(pi, ei, 1)} disabled={ei === phase.entries.length - 1} title="Move down"><ArrowDown size={13} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => removeEntry(pi, ei)} title="Remove step" style={{ color: 'var(--ds-red)' }}><Trash2 size={13} /></Button>
                      </div>
                      {/* line 2: controls */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                        <label style={chk}>Owner
                          <select value={entry.owner} onChange={(e) => patchEntry(pi, ei, { owner: e.target.value as TemplateEntry['owner'] })} className={selCls}>
                            <option value="DRIVER">Driver</option>
                            <option value="OFFICE">Office / HR</option>
                          </select>
                        </label>
                        <label style={chk}>Record
                          <select value={entry.entity ?? 'DRIVER'} onChange={(e) => patchEntry(pi, ei, { entity: e.target.value as TemplateEntry['entity'] })} className={selCls}>
                            <option value="DRIVER">Driver</option>
                            <option value="TRUCK">Truck</option>
                          </select>
                        </label>
                        <label style={chk}>
                          <input type="checkbox" checked={visible} onChange={(e) => patchEntry(pi, ei, { driverVisible: e.target.checked })} />
                          {visible ? <Eye size={12} /> : <EyeOff size={12} />} Driver sees it
                        </label>
                        <label style={chk}>
                          <input type="checkbox" checked={entry.required ?? req?.required ?? true} onChange={(e) => patchEntry(pi, ei, { required: e.target.checked })} />
                          Required
                        </label>
                        <label style={chk}>
                          <input type="checkbox" checked={entry.requiresDocument ?? req?.requiresDocument ?? false} onChange={(e) => patchEntry(pi, ei, { requiresDocument: e.target.checked })} />
                          Needs document
                        </label>
                        <label style={chk}>Due +
                          <input type="number" min={0} value={entry.dueDaysFromPhaseStart ?? ''} onChange={(e) => patchEntry(pi, ei, { dueDaysFromPhaseStart: e.target.value === '' ? undefined : Number(e.target.value) })} style={{ width: 52 }} className={selCls} /> days
                        </label>
                        <label style={chk}>Assignee
                          <input value={entry.assignee ?? ''} onChange={(e) => patchEntry(pi, ei, { assignee: e.target.value || undefined })} placeholder="e.g. Ivan Cartage HR" style={{ width: 130 }} className={selCls} />
                        </label>
                        <span style={{ fontSize: 11, color: 'var(--ds-t3)', fontFamily: 'var(--font-mono)' }}>{entry.key}</span>
                      </div>
                    </div>
                  )
                })}

                <AddStep onAdd={(key) => addEntry(pi, key)} />
              </div>
            </div>
          ))}

          <Button size="sm" variant="outline" onClick={addPhase}><Plus size={14} /> Add phase</Button>
        </div>
      )}
    </Card>
  )
}

function AddStep({ onAdd }: { onAdd: (key: string) => void }) {
  const [key, setKey] = useState('')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px' }}>
      <select value={key} onChange={(e) => setKey(e.target.value)} className="h-8 rounded-md border border-input bg-white px-2 text-xs" style={{ minWidth: 260 }}>
        <option value="">+ Add a step…</option>
        {ALL_REQUIREMENTS.map((r) => <option key={r.key} value={r.key}>{r.label} ({r.key})</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!key} onClick={() => { onAdd(key); setKey('') }}><Plus size={13} /> Add</Button>
    </div>
  )
}
