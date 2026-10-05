import { useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Search, Building2, MapPin, RefreshCw, Archive, Merge, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDirectory, type CustomerRecord, type LocationRecord } from '@/hooks/useDirectory'
import { isActiveDirectoryRecord } from '@/lib/tmsDirectory'
import { graphqlErrorText, listDivisions, previewLocationMerge, startLocationMerge, resumeLocationMerge, listLocationMergeJobs } from '@/lib/apiClient'
import type { Division, LocationMergeJob, LocationMergePreview } from '@/types/tms'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CustomerForm } from './components/CustomerForm'
import { useCustomerForm } from './components/useCustomerForm'
import { LocationForm } from './components/LocationForm'
import { useLocationForm } from './components/useLocationForm'
import { LocationDetail } from './components/LocationDetail'

function PageShell({ title, sub, icon, count, query, setQuery, onAdd, onRefresh, children }: {
  title: string; sub: string; icon: React.ReactNode; count: number
  query: string; setQuery: (q: string) => void; onAdd: () => void; onRefresh: () => void
  children: React.ReactNode
}) {
  const isMobile = useIsMobile()
  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>{icon}{title}<span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t3)' }}>{count}</span></h1>
            <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>{sub}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', minWidth: 220 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-t3)', pointerEvents: 'none' }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label={`Search ${title.toLowerCase()}`}
                style={{ height: 34, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px 0 30px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', boxSizing: 'border-box' }} />
            </div>
            <button onClick={onRefresh} title="Refresh" style={{ height: 34, width: 34, borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><RefreshCw size={14} /></button>
            <button onClick={onAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--ds-blue, #2563eb)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}><Plus size={14} /> Add</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }

function stripRecord<T extends { id: string; createdAt: string; updatedAt: string }>(record: T): Omit<T, 'id' | 'createdAt' | 'updatedAt'> {
  const { id, createdAt, updatedAt, ...rest } = record
  return rest as Omit<T, 'id' | 'createdAt' | 'updatedAt'>
}

export function CustomersPage() {
  const dir = useDirectory()
  const { isAdmin } = useAuth()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CustomerRecord | 'new' | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])

  useEffect(() => {
    listDivisions().then(setDivisions).catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load divisions'))
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.customers.filter((c) =>
      !q || [c.name, c.contactName, c.contactEmail, c.mcNumber, c.dotNumber].some((v) => (v ?? '').toLowerCase().includes(q))
    )
  }, [dir.customers, query])

  useEffect(() => { if (dir.error) toast.error(dir.error) }, [dir.error])

  const archive = async (c: CustomerRecord) => {
    if (!window.confirm(`Archive customer "${c.name}"?\n\nLoads keep their customer name; only the directory entry is marked inactive.`)) return
    try { await dir.archiveCustomer(c); toast.success('Customer archived') } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <PageShell title="Customers" icon={<Building2 size={18} />} count={dir.customers.filter(isActiveDirectoryRecord).length}
      sub="Customers with billing contacts, terms, credit limits, aliases and default division/sales rep."
      query={query} setQuery={setQuery} onAdd={() => setEditing('new')} onRefresh={dir.refresh}>
      {dir.loading && rows.length === 0 ? <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ ...cardStyle, justifyContent: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>No customers yet — add the first one.</div>
        : rows.map((c) => (
          <div key={c.id} style={cardStyle}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ds-t1)' }}>
                {c.name}
                {c.apptWorkflow === 'BATORY' && <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: '#eff6ff', color: '#0369a1' }}>BATORY</span>}
                {c.active === false && <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: '#f3f4f6', color: '#6b7280' }}>ARCHIVED</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 3 }}>
                {c.contactName || <span style={{ color: 'var(--ds-t3)' }}>no contact yet</span>}
                {c.contactEmail && <span style={{ color: 'var(--ds-t3)' }}> · {c.contactEmail}</span>}
                {c.contactPhone && <span style={{ color: 'var(--ds-t3)' }}> · {c.contactPhone}</span>}
                {c.mcNumber && <span style={{ color: 'var(--ds-t3)' }}> · MC {c.mcNumber}</span>}
                {c.dotNumber && <span style={{ color: 'var(--ds-t3)' }}> · DOT {c.dotNumber}</span>}
              </div>
              {/*
                * Factored or not, and the booking rules that follow from it.
                *
                * Only a factored customer's loads reach OTR, and only OTR needs an MC and
                * origin/destination ZIPs. Marking a customer here is what decides whether
                * booking one of their loads demands that paperwork — so it sits on the row
                * rather than behind the edit dialog, where nobody would find it.
                */}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11.5, color: c.factored ? '#047857' : 'var(--ds-t3)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={c.factored === true}
                  onChange={(e) => void dir.saveCustomer(c, { factored: e.target.checked })}
                  aria-label={`${c.name} is factored`}
                />
                {c.factored
                  ? 'Factored — loads need an MC and both ZIPs'
                  : 'Not factored — no MC or ZIP needed to book'}
              </label>
              {(c.billingEmail || c.billingAddress?.city) && (
                <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>
                  Billing: {[c.billingContactName, c.billingEmail, c.billingAddress?.city].filter(Boolean).join(' · ')}
                </div>
              )}
              {c.aliases && c.aliases.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>Aliases: {c.aliases.join(', ')}</div>}
              {c.notes && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>{c.notes}</div>}
            </div>
            <button onClick={() => setEditing(c)} title="Edit" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Pencil size={14} /></button>
            {isAdmin && (
              <button onClick={() => archive(c)} title="Archive" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Archive size={14} /></button>
            )}
          </div>
        ))}

      <CustomerModal
        // The form hook seeds its state once; remount per record so Edit shows that record
        // (a stale form would otherwise overwrite it with blanks on Save).
        key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.id}
        open={editing !== null}
        initial={editing === 'new' ? undefined : editing ?? undefined}
        divisions={divisions}
        onClose={() => setEditing(null)}
        onSave={async (record) => {
          if (editing === 'new') {
            await dir.addCustomer(stripRecord(record) as Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>)
            toast.success('Customer added')
          } else if (editing) {
            await dir.saveCustomer(editing, stripRecord(record))
            toast.success('Customer saved')
          }
          setEditing(null)
        }}
      />
    </PageShell>
  )
}

function CustomerModal({ open, initial, divisions, onClose, onSave }: {
  open: boolean; initial?: CustomerRecord; divisions: Division[]; onClose: () => void; onSave: (record: CustomerRecord) => Promise<void>
}) {
  const { value, set, toRecord, errors } = useCustomerForm(initial ?? null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (Object.keys(errors).length > 0) { toast.error('Please fix the errors above'); return }
    setSaving(true)
    try { await onSave(toRecord()); onClose() } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{initial ? 'Edit customer' : 'Add customer'}</DialogTitle></DialogHeader>
        <CustomerForm value={value} set={set} errors={errors} divisions={divisions} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function LocationsPage() {
  const dir = useDirectory()
  const { isAdmin } = useAuth()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<LocationRecord | 'new' | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.locations.filter((l) =>
      !q || [l.name, l.city, l.state, l.customerName, l.apptContactEmail, l.street, l.zip].some((v) => (v ?? '').toLowerCase().includes(q))
    )
  }, [dir.locations, query])

  useEffect(() => { if (dir.error) toast.error(dir.error) }, [dir.error])

  const archive = async (l: LocationRecord) => {
    if (!window.confirm(`Archive location "${l.name}"?\n\nLoads keep their stop address; only the directory entry is marked inactive.`)) return
    try { await dir.archiveLocation(l); toast.success('Location archived') } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <PageShell title="Locations" icon={<MapPin size={18} />} count={dir.locations.filter(isActiveDirectoryRecord).length}
      sub="Facilities with full address, geocode, contacts, hours, appointment rules and linked customers."
      query={query} setQuery={setQuery} onAdd={() => setEditing('new')} onRefresh={dir.refresh}>
      {dir.loading && rows.length === 0 ? <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ ...cardStyle, justifyContent: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>No locations yet — add the first one.</div>
        : rows.map((l) => (
          <div key={l.id} style={{ ...cardStyle, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ds-t1)' }}>
                {l.name}
                {l.city && <span style={{ fontWeight: 500, color: 'var(--ds-t3)' }}> — {l.city}</span>}
                {l.facilityType && <span style={{ fontSize: 10.5, fontWeight: 700, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: '#eff6ff', color: '#0369a1' }}>{l.facilityType}</span>}
                {l.active === false && <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: '#f3f4f6', color: '#6b7280' }}>ARCHIVED</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 3 }}>
                {[l.street, [l.city, l.state].filter(Boolean).join(', '), l.zip, l.country].filter(Boolean).join(' · ') || <span style={{ color: 'var(--ds-t3)' }}>no address yet</span>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>
                Appt: {l.apptRule ?? '—'}
                {l.apptLeadTimeHours != null && <span> · Lead time {l.apptLeadTimeHours}h</span>}
                {l.hours && <span> · Hours {l.hours}</span>}
              </div>
              {l.apptContactEmail && (
                <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>
                  Appt contact: {[l.apptContactName, l.apptContactEmail, l.apptContactPhone].filter(Boolean).join(' · ')}
                </div>
              )}
              {l.customerIds && l.customerIds.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>
                  Customers: {l.customerIds.map((id) => dir.customers.find((c) => c.id === id)?.name ?? id).join(', ')}
                </div>
              )}
              {l.aliases && l.aliases.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>Aliases: {l.aliases.join(', ')}</div>}
            </div>
            <button onClick={() => setOpenId(openId === l.id ? null : l.id)} title={openId === l.id ? 'Hide details' : 'Map and load history'} style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}>{openId === l.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
            <button onClick={() => setEditing(l)} title="Edit" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Pencil size={14} /></button>
            {isAdmin && (
              <>
                <button onClick={() => archive(l)} title="Archive" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Archive size={14} /></button>
                <button onClick={() => setMergeOpen(true)} title="Merge" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Merge size={14} /></button>
              </>
            )}
            {openId === l.id && <div style={{ flexBasis: '100%' }}><LocationDetail location={l} /></div>}
          </div>
        ))}

      <LocationModal
        key={editing === null ? 'closed' : editing === 'new' ? 'new' : editing.id}
        open={editing !== null}
        initial={editing === 'new' ? undefined : editing ?? undefined}
        customers={dir.customers}
        onClose={() => setEditing(null)}
        onSave={async (record, geocodeToken) => {
          const input = { ...stripRecord(record), ...(geocodeToken ? { geocodeToken } : {}) } as Omit<LocationRecord, 'id' | 'createdAt' | 'updatedAt'> & { geocodeToken?: string }
          if (editing === 'new') {
            await dir.addLocation(input)
            toast.success('Location added')
          } else if (editing) {
            await dir.saveLocation(editing, input)
            toast.success('Location saved')
          }
          setEditing(null)
        }}
      />

      {isAdmin && <MergeLocationDialog open={mergeOpen} onClose={() => setMergeOpen(false)} locations={dir.locations} />}
    </PageShell>
  )
}

function LocationModal({ open, initial, customers, onClose, onSave }: {
  open: boolean; initial?: LocationRecord; customers: CustomerRecord[]; onClose: () => void; onSave: (record: LocationRecord, geocodeToken?: string) => Promise<void>
}) {
  const { value, set, setAddressField, toRecord, getGeocodeToken, errors } = useLocationForm(initial ?? null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (Object.keys(errors).length > 0) { toast.error('Please fix the errors above'); return }
    setSaving(true)
    try { await onSave(toRecord(), getGeocodeToken() ?? undefined); onClose() } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{initial ? 'Edit location' : 'Add location'}</DialogTitle></DialogHeader>
        <LocationForm value={value} set={set} setAddressField={setAddressField} errors={errors} customers={customers} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MergeLocationDialog({
  open, onClose, locations,
}: { open: boolean; onClose: () => void; locations: LocationRecord[] }) {
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [preview, setPreview] = useState<LocationMergePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [job, setJob] = useState<LocationMergeJob | null>(null)
  const [jobIdInput, setJobIdInput] = useState('')
  const [jobs, setJobs] = useState<LocationMergeJob[]>([])
  const [jobsLoaded, setJobsLoaded] = useState(false)

  const candidates = useMemo(() => locations.filter((loc) => loc.active !== false).sort((a, b) => a.name.localeCompare(b.name)), [locations])

  useEffect(() => {
    if (!open || jobsLoaded) return
    listLocationMergeJobs()
      .then((list) => { setJobs(list); setJobsLoaded(true) })
      .catch((e: unknown) => { setJobsLoaded(true); toast.error(graphqlErrorText(e) || 'Could not load merge jobs') })
  }, [open, jobsLoaded])

  const canPreview = sourceId && targetId && sourceId !== targetId

  const runPreview = async () => {
    if (!canPreview) return
    setPreview(null)
    setPreviewing(true)
    try { setPreview(await previewLocationMerge(sourceId, targetId)) } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setPreviewing(false) }
  }

  const runMerge = async () => {
    if (!sourceId || !targetId) return
    setPreview(null)
    try {
      const j = await startLocationMerge(sourceId, targetId)
      setJob(j)
      toast.success('Merge started')
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  const runResume = async () => {
    if (!jobIdInput.trim()) return
    try {
      const j = await resumeLocationMerge(jobIdInput.trim())
      setJob(j)
      toast.success('Merge resumed')
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Merge locations (admin only)</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Source</Label>
              <select value={sourceId} onChange={(e) => { setSourceId(e.target.value); setPreview(null) }} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">Select source</option>
                {candidates.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.city ?? '—'}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Target</Label>
              <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setPreview(null) }} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">Select target</option>
                {candidates.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.city ?? '—'}</option>)}
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={runPreview} disabled={!canPreview || previewing}>
              {previewing ? '…' : 'Preview'}
            </Button>
            <Button type="button" size="sm" className="h-9" onClick={runMerge} disabled={!canPreview || previewing}>
              Start merge
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">{preview.loadCount} load(s) will point to the target.</p>
              <p className="text-muted-foreground mt-1">Source {preview.sourceId} → target {preview.targetId}</p>
            </div>
          )}

          {job && (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">Merge job {job.id}</p>
              <p className="text-muted-foreground mt-1">Status: {job.status}</p>
              <p className="text-muted-foreground">Processed: {job.processedCount}{job.remainingCount != null ? ` / ${job.processedCount + job.remainingCount}` : ''}</p>
              {job.error && <p className="text-destructive mt-1">{job.error}</p>}
            </div>
          )}

          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <div>
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Resume existing job</Label>
              <Input value={jobIdInput} onChange={(e) => setJobIdInput(e.target.value)} placeholder="Job ID" className="h-9 text-sm" />
            </div>
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={runResume} disabled={!jobIdInput.trim()}>
              Resume
            </Button>
          </div>

          {jobs.length > 0 && (
            <div className="rounded-md border p-3 space-y-1 text-sm">
              <p className="font-medium">Recent jobs</p>
              {jobs.slice(0, 5).map((j) => (
                <div key={j.id} className="flex justify-between text-xs text-muted-foreground">
                  <span>{j.id} · {j.status}</span>
                  <span>{j.processedCount}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
