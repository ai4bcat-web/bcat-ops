import { useEffect, useState, type CSSProperties } from 'react'
import {
  ChevronDown, ChevronRight, Plus, Trash2, ArrowUp, ArrowDown, Save, RotateCcw, GripVertical, Info,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { getTemplateConfig, saveTemplateConfig, deleteTemplateConfig } from '@/lib/complianceClient'
import { AMAZON_DRIVER_TEMPLATE, type OnboardingTemplate, type TemplateEntry } from '@/lib/onboardingTemplates'
import { getRequirement, ALL_REQUIREMENTS } from '@/lib/complianceRequirements'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const selCls = 'h-8 rounded-md border border-input bg-white px-2 text-xs'

function effectiveVisible(e: TemplateEntry): boolean {
  return e.driverVisible ?? (e.owner === 'DRIVER' && (e.entity ?? 'DRIVER') === 'DRIVER')
}

// Small filled/outline toggle chip.
function Chip({ on, tone = 'blue', onClick, children }: { on: boolean; tone?: 'blue' | 'green' | 'violet'; onClick: () => void; children: React.ReactNode }) {
  const fg = tone === 'green' ? 'var(--ds-green)' : tone === 'violet' ? '#6d28d9' : 'var(--ds-blue-dark)'
  const bg = tone === 'green' ? 'var(--ds-green-bg)' : tone === 'violet' ? 'var(--ds-violet-bg)' : 'var(--ds-blue-bg)'
  return (
    <button type="button" onClick={onClick}
      style={{ borderRadius: 999, padding: '4px 11px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
        border: `1px solid ${on ? fg : 'var(--ds-border)'}`, background: on ? bg : 'var(--ds-surface)', color: on ? fg : 'var(--ds-t3)' }}>
      {children}
    </button>
  )
}

// Read-only tag for the collapsed card header.
function Tag({ color, bg, children }: { color: string; bg: string; children: React.ReactNode }) {
  return <span style={{ borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600, background: bg, color }}>{children}</span>
}

interface Props { open: boolean; onOpenChange: (open: boolean) => void }

export function OnboardingTemplateEditor({ open, onOpenChange }: Props) {
  const { user } = useAuth()
  const [draft, setDraft] = useState<OnboardingTemplate | null>(null)
  const [customized, setCustomized] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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
  useEffect(() => { if (open) load() }, [open])

  function mutate(fn: (d: OnboardingTemplate) => void) {
    setDraft((prev) => { if (!prev) return prev; const next = clone(prev); fn(next); return next })
    setDirty(true)
  }
  const patchEntry = (pi: number, ei: number, patch: Partial<TemplateEntry>) =>
    mutate((d) => { d.phases[pi].entries[ei] = { ...d.phases[pi].entries[ei], ...patch } })
  const moveEntry = (pi: number, ei: number, dir: -1 | 1) =>
    mutate((d) => { const arr = d.phases[pi].entries; const j = ei + dir; if (j < 0 || j >= arr.length) return; [arr[ei], arr[j]] = [arr[j], arr[ei]] })
  const removeEntry = (pi: number, ei: number) => mutate((d) => { d.phases[pi].entries.splice(ei, 1) })
  const addEntry = (pi: number, key: string) => mutate((d) => { const req = getRequirement(key); d.phases[pi].entries.push({ key, owner: req?.driverActionable ? 'DRIVER' : 'OFFICE' }) })
  const addPhase = () => mutate((d) => { d.phases.push({ phase: d.phases.length + 1, title: `Phase ${d.phases.length + 1}`, entries: [] }) })

  const toggleExpand = (k: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      const normalized: OnboardingTemplate = { ...draft, phases: draft.phases.map((p, i) => ({ ...p, phase: i + 1 })) }
      await saveTemplateConfig(normalized, user?.email ?? undefined)
      setDraft(clone(normalized)); setCustomized(true); setDirty(false)
      toast.success('Onboarding template saved — new drivers will use this version')
    } catch (e) { console.error(e); toast.error('Could not save template') }
    finally { setSaving(false) }
  }

  async function resetToDefault() {
    setSaving(true)
    try {
      await deleteTemplateConfig(AMAZON_DRIVER_TEMPLATE.id)
      setCustomized(false); setDraft(clone(AMAZON_DRIVER_TEMPLATE)); setDirty(false)
      toast.success('Reset to the built-in default template')
    } catch (e) { console.error(e); toast.error('Could not reset') }
    finally { setSaving(false) }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent style={{ width: 'min(780px, 96vw)', display: 'flex', flexDirection: 'column', padding: 0 }}>
        <SheetHeader style={{ padding: '18px 20px 12px' }}>
          <SheetTitle style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            Edit onboarding template
            <Badge variant={customized ? 'default' : 'secondary'}>{customized ? 'Customized' : 'Default'}</Badge>
          </SheetTitle>
        </SheetHeader>

        <SheetBody style={{ flex: 1, overflowY: 'auto', padding: '0 20px 12px' }}>
          {/* Applies-to banner */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, borderRadius: 10, padding: '10px 12px', marginBottom: 14, background: 'var(--ds-blue-bg)', border: '1px solid var(--ds-border)' }}>
            <Info size={15} style={{ color: 'var(--ds-blue-dark)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: 'var(--ds-t2)' }}>
              Edits apply to <strong>new</strong> drivers you onboard — checklists already generated aren’t changed.
            </div>
          </div>

          {loading || !draft ? (
            <div style={{ fontSize: 13, color: 'var(--ds-t3)', padding: '20px 0' }}>Loading…</div>
          ) : (
            draft.phases.map((phase, pi) => (
              <div key={pi} style={{ marginBottom: 18 }}>
                {/* Phase header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ds-t3)' }}>PHASE {pi + 1}</span>
                  <Input value={phase.title} onChange={(e) => mutate((d) => { d.phases[pi].title = e.target.value })} className="h-8 flex-1" placeholder="Phase title" />
                </div>

                {/* Step cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {phase.entries.map((entry, ei) => {
                    const req = getRequirement(entry.key)
                    const key = `${pi}:${ei}`
                    const isOpen = expanded.has(key)
                    const visible = effectiveVisible(entry)
                    const required = entry.required ?? req?.required ?? true
                    const needsDoc = entry.requiresDocument ?? req?.requiresDocument ?? false
                    const eLinks = entry.links ?? req?.links ?? []
                    return (
                      <div key={ei} style={{ border: '1px solid var(--ds-border)', borderRadius: 10, background: 'var(--ds-surface)', boxShadow: 'var(--sh-sm)', overflow: 'hidden' }}>
                        {/* Collapsed header */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px' }}>
                          <GripVertical size={14} style={{ color: 'var(--ds-t4, var(--ds-t3))', flexShrink: 0 }} />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ds-t3)', width: 18, textAlign: 'right' }}>{ei + 1}</span>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--ds-t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label || req?.label || entry.key}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            {entry.owner === 'OFFICE'
                              ? <Tag color="#6d28d9" bg="var(--ds-violet-bg)">HR</Tag>
                              : <Tag color="var(--ds-blue-dark)" bg="var(--ds-blue-bg)">Driver</Tag>}
                            {required && <Tag color="var(--ds-red)" bg="var(--ds-red-bg)">Req</Tag>}
                            {needsDoc && <Tag color="var(--ds-t2)" bg="var(--ds-bg-3)">Doc</Tag>}
                            {visible && <Tag color="var(--ds-green)" bg="var(--ds-green-bg)">Sees</Tag>}
                          </div>
                          <Button size="icon" variant="ghost" className="size-7" onClick={() => moveEntry(pi, ei, -1)} disabled={ei === 0} aria-label="Move up"><ArrowUp size={13} /></Button>
                          <Button size="icon" variant="ghost" className="size-7" onClick={() => moveEntry(pi, ei, 1)} disabled={ei === phase.entries.length - 1} aria-label="Move down"><ArrowDown size={13} /></Button>
                          <Button size="icon" variant="ghost" className="size-7" onClick={() => toggleExpand(key)} aria-label="Expand">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</Button>
                        </div>

                        {/* Expanded body */}
                        {isOpen && (
                          <div style={{ borderTop: '1px solid var(--ds-border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--ds-bg-2)' }}>
                            <div>
                              <label style={labelStyle}>Title (driver-facing)</label>
                              <Input value={entry.label ?? ''} onChange={(e) => patchEntry(pi, ei, { label: e.target.value || undefined })} placeholder={req?.label ?? entry.key} className="h-8" />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                              <div><label style={labelStyle}>Owner</label>
                                <select value={entry.owner} onChange={(e) => patchEntry(pi, ei, { owner: e.target.value as TemplateEntry['owner'] })} className={`${selCls} w-full h-8`}>
                                  <option value="DRIVER">Driver</option><option value="OFFICE">Office / HR</option>
                                </select>
                              </div>
                              <div><label style={labelStyle}>Record</label>
                                <select value={entry.entity ?? 'DRIVER'} onChange={(e) => patchEntry(pi, ei, { entity: e.target.value as TemplateEntry['entity'] })} className={`${selCls} w-full h-8`}>
                                  <option value="DRIVER">Driver</option><option value="TRUCK">Truck</option>
                                </select>
                              </div>
                              <div><label style={labelStyle}>Due (days)</label>
                                <input type="number" min={0} value={entry.dueDaysFromPhaseStart ?? ''} onChange={(e) => patchEntry(pi, ei, { dueDaysFromPhaseStart: e.target.value === '' ? undefined : Number(e.target.value) })} className={`${selCls} w-full h-8`} />
                              </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                              <div><label style={labelStyle}>Assignee</label>
                                <Input value={entry.assignee ?? ''} onChange={(e) => patchEntry(pi, ei, { assignee: e.target.value || undefined })} placeholder="e.g. Ivan Cartage HR" className="h-8" />
                              </div>
                              <div><label style={labelStyle}>Step key</label>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ds-t3)', paddingTop: 8 }}>{entry.key}</div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              <Chip on={visible} tone="green" onClick={() => patchEntry(pi, ei, { driverVisible: !visible })}>Driver sees</Chip>
                              <Chip on={required} tone="blue" onClick={() => patchEntry(pi, ei, { required: !required })}>Required</Chip>
                              <Chip on={needsDoc} tone="violet" onClick={() => patchEntry(pi, ei, { requiresDocument: !needsDoc })}>Needs document</Chip>
                            </div>
                            {/* Driver-facing links */}
                            <div>
                              <label style={labelStyle}>Driver-facing links (forms / policies)</label>
                              {eLinks.map((l, li) => (
                                <div key={li} style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                                  <input value={l.label} onChange={(e) => patchEntry(pi, ei, { links: eLinks.map((x, i) => (i === li ? { ...x, label: e.target.value } : x)) })} placeholder="Label" className={`${selCls} h-8`} style={{ width: 180 }} />
                                  <input value={l.url} onChange={(e) => patchEntry(pi, ei, { links: eLinks.map((x, i) => (i === li ? { ...x, url: e.target.value } : x)) })} placeholder="https://…" className={`${selCls} h-8`} style={{ flex: 1 }} />
                                  <Button size="icon" variant="ghost" className="size-7" onClick={() => patchEntry(pi, ei, { links: eLinks.filter((_, i) => i !== li) })} aria-label="Remove link" style={{ color: 'var(--ds-red)' }}><Trash2 size={12} /></Button>
                                </div>
                              ))}
                              <button type="button" onClick={() => patchEntry(pi, ei, { links: [...eLinks, { label: '', url: '' }] })}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 12, color: 'var(--ds-blue-dark)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                <Plus size={12} /> add link
                              </button>
                            </div>
                            <div>
                              <Button size="sm" variant="ghost" onClick={() => removeEntry(pi, ei)} style={{ color: 'var(--ds-red)' }}><Trash2 size={13} /> Remove step</Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <AddStep onAdd={(key) => addEntry(pi, key)} />
                </div>
              </div>
            ))
          )}

          {draft && <Button size="sm" variant="outline" onClick={addPhase}><Plus size={14} /> Add phase</Button>}
        </SheetBody>

        {/* Pinned footer */}
        <SheetFooter style={{ padding: '12px 20px', borderTop: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {customized && <Button variant="outline" onClick={resetToDefault} disabled={saving}><RotateCcw size={14} /> Reset to default</Button>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={save} disabled={saving || !dirty}><Save size={14} /> {saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

const labelStyle: CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }

function AddStep({ onAdd }: { onAdd: (key: string) => void }) {
  const [key, setKey] = useState('')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <select value={key} onChange={(e) => setKey(e.target.value)} className={`${selCls} h-8`} style={{ minWidth: 260 }}>
        <option value="">+ Add a step…</option>
        {ALL_REQUIREMENTS.map((r) => <option key={r.key} value={r.key}>{r.label} ({r.key})</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!key} onClick={() => { onAdd(key); setKey('') }}><Plus size={13} /> Add</Button>
    </div>
  )
}
