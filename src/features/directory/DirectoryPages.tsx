import { useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Search, Building2, MapPin, RefreshCw, Archive, Merge, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDirectory, type CustomerRecord, type LocationRecord } from '@/hooks/useDirectory'
import { isActiveDirectoryRecord } from '@/lib/tmsDirectory'
import { graphqlErrorText, listDivisions, previewLocationMerge, startLocationMerge, resumeLocationMerge, listLocationMergeJobs, getTmsSettings, saveTmsSettings } from '@/lib/apiClient'
import { effectiveCustomerStatus, boardTab } from '@/lib/customerCredit'
import type { Division, LocationMergeJob, LocationMergePreview, TmsSettings, ChargeCodeDef } from '@/types/tms'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { CustomerForm } from './components/CustomerForm'
import { useCustomerForm } from './components/useCustomerForm'
import { LocationForm } from './components/LocationForm'
import { useLocationForm } from './components/useLocationForm'
import { LocationDetail } from './components/LocationDetail'
import { CustomerProfile } from './components/CustomerProfile'
import { cn } from '@/lib/utils'
import { CustomerOrgDefaults } from './components/CustomerOrgDefaults'

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

const statusColors: Record<NonNullable<CustomerRecord['status']>, string> = {
  NEW: 'bg-slate-100 text-slate-700',
  CONTACTED: 'bg-blue-100 text-blue-700',
  QUALIFIED: 'bg-indigo-100 text-indigo-700',
  QUOTED: 'bg-purple-100 text-purple-700',
  NURTURING: 'bg-pink-100 text-pink-700',
  PENDING: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  DORMANT: 'bg-orange-100 text-orange-700',
  CLOSED: 'bg-gray-100 text-gray-700',
  BLOCKED: 'bg-red-100 text-red-700',
}

export function CustomersPage() {
  const dir = useDirectory({ includeArchived: true })
  const { isAdmin, user } = useAuth()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CustomerRecord | 'new' | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  useEffect(() => {
    listDivisions().then(setDivisions).catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load divisions'))
    getTmsSettings()
      .then((s) => setSettings(s))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load settings'))
  }, [])

  const catalog = useMemo<ChargeCodeDef[]>(() => settings?.chargeCodes ?? [], [settings])

  const rowsWithStatus = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.customers
      .filter((c) =>
        !q || [c.name, c.contactName, c.contactEmail, c.mcNumber, c.dotNumber].some((v) => (v ?? '').toLowerCase().includes(q))
      )
      .map((c) => ({ record: c, effective: effectiveCustomerStatus(c, null, new Date().toISOString()), tab: boardTab(effectiveCustomerStatus(c, null, new Date().toISOString())) }))
  }, [dir.customers, query])

  const counts = useMemo(() => ({
    leads: rowsWithStatus.filter((r) => r.tab === 'leads').length,
    active: rowsWithStatus.filter((r) => r.tab === 'active').length,
    inactive: rowsWithStatus.filter((r) => r.tab === 'inactive').length,
  }), [rowsWithStatus])

  const [activeTab, setActiveTab] = useState<'leads' | 'active' | 'inactive'>('active')

  const visibleRows = useMemo(() => rowsWithStatus.filter((r) => r.tab === activeTab), [rowsWithStatus, activeTab])

  useEffect(() => { if (dir.error) toast.error(dir.error) }, [dir.error])

  const profileCustomer = useMemo(() => dir.customers.find((c) => c.id === profileId) ?? null, [dir.customers, profileId])

  const archive = async (c: CustomerRecord) => {
    if (!window.confirm(`Archive customer "${c.name}"?\n\nLoads keep their customer name; only the directory entry is marked inactive.`)) return
    try { await dir.archiveCustomer(c); toast.success('Customer archived') } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  const saveSettings = async (patch: Parameters<typeof saveTmsSettings>[0]) => {
    if (!isAdmin) throw new Error('Admin only')
    const next = await saveTmsSettings(patch, settings?.updatedAt)
    setSettings(next)
    toast.success('Org defaults saved')
  }

  return (
    <PageShell title="Customers" icon={<Building2 size={18} />} count={dir.customers.filter(isActiveDirectoryRecord).length}
      sub="Leads, active accounts and inactive customers with credit, contacts, billing and quoting defaults."
      query={query} setQuery={setQuery} onAdd={() => setEditing('new')} onRefresh={dir.refresh}>
      <div className="flex items-center gap-2 border-b pb-2">
        {(['leads', 'active', 'inactive'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setActiveTab(t)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md capitalize',
              activeTab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {t}
            <span className="rounded-full bg-background/50 px-1.5">{t === 'leads' ? counts.leads : t === 'active' ? counts.active : counts.inactive}</span>
          </button>
        ))}
      </div>
      {isAdmin && <div><Button variant="outline" size="sm" onClick={() => setShowDefaults(true)}>Organization defaults</Button></div>}
      {showDefaults && <CustomerOrgDefaults settings={settings} onSave={saveSettings} onClose={() => setShowDefaults(false)} />}
      {dir.loading && visibleRows.length === 0 ? <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
        : visibleRows.length === 0 ? <div style={{ ...cardStyle, justifyContent: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>No customers in this tab.</div>
        : visibleRows.map(({ record: c, effective }) => (
          <div key={c.id} style={cardStyle}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ds-t1)' }}>
                <button
                  type="button"
                  onClick={() => setProfileId(c.id)}
                  className="text-left hover:underline"
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
                >
                  {c.name}
                </button>
                {c.apptWorkflow === 'BATORY' && <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: '#eff6ff', color: '#0369a1' }}>BATORY</span>}
                {c.status && <Badge variant="secondary" className={cn('ml-2 text-[10px]', statusColors[c.status])}>{c.status}</Badge>}
                {c.status && effective !== c.status && <span className="ml-2 text-[10px] text-muted-foreground">(effective {effective})</span>}
                {c.active === false && <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: '#f3f4f6', color: '#6b7280' }}>ARCHIVED</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 3 }}>
                {c.contactName || <span style={{ color: 'var(--ds-t3)' }}>no contact yet</span>}
                {c.contactEmail && <span style={{ color: 'var(--ds-t3)' }}> · {c.contactEmail}</span>}
                {c.contactPhone && <span style={{ color: 'var(--ds-t3)' }}> · {c.contactPhone}</span>}
                {c.mcNumber && <span style={{ color: 'var(--ds-t3)' }}> · MC {c.mcNumber}</span>}
                {c.dotNumber && <span style={{ color: 'var(--ds-t3)' }}> · DOT {c.dotNumber}</span>}
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11.5, color: c.factored ? '#047857' : 'var(--ds-t3)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={c.factored === true}
                  onChange={(e) => void dir.saveCustomer(c, { factored: e.target.checked })}
                  aria-label={`${c.name} is factored`}
                />
                {c.factored ? 'Factored — loads need an MC and both ZIPs' : 'Not factored — no MC or ZIP needed to book'}
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

      {profileCustomer && (
        <CustomerProfile
          customer={profileCustomer}
          divisions={divisions}
          locations={dir.locations}
          settings={settings}
          catalog={catalog}
          isAdmin={isAdmin}
          currentUser={user?.email ?? ''}
          activeCustomers={dir.customers.filter((c) => c.id !== profileCustomer.id && c.active !== false && c.status !== 'BLOCKED')}
          onClose={() => setProfileId(null)}
          onSave={async (current, next) => {
            await dir.saveCustomer(current, next)
            toast.success('Customer saved')
          }}
          onStatusChange={async (current, input) => {
            await dir.setCustomerStatus(current, input)
            toast.success('Status updated')
          }}
        />
      )}
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
            <div className="rounded-md bg-muted p-3 text-sm space-y-1">
              <p>Load count: {preview.loadCount}</p>
            </div>
          )}

          <div className="border-t pt-3 space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Resume job</Label>
            <div className="flex gap-2">
              <Input value={jobIdInput} onChange={(e) => setJobIdInput(e.target.value)} placeholder="Job ID" className="h-9 text-sm" />
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={runResume}>Resume</Button>
            </div>
            {job && <p className="text-xs text-muted-foreground">Job {job.id}: {job.status}</p>}
            {jobs.length > 0 && (
              <div className="max-h-32 overflow-y-auto space-y-1">
                {jobs.map((j) => (
                  <div key={j.id} className="text-xs text-muted-foreground">{j.id} · {j.status} · {j.processedCount}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
