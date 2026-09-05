import { useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, Search, Building2, MapPin, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDirectory, type CustomerRecord, type LocationRecord } from '@/hooks/useDirectory'

/**
 * The directory — Customers and Locations, the reusable address book behind the Load
 * form. A Customer carries its contact; a Location carries the APPOINTMENT contact
 * (who you email to request/book an appt time). Names entered here appear as
 * suggestions on the Load form so they are typed once and reselected forever.
 */

const input: React.CSSProperties = { height: 34, width: '100%', borderRadius: 8, border: '1px solid var(--ds-border)', padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)', color: 'var(--ds-t1)', boxSizing: 'border-box' }
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', display: 'block', marginBottom: 4 }

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onMouseDown={onClose}>
      <div style={{ width: 520, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--ds-surface)', borderRadius: 14, padding: 20, boxShadow: 'var(--sh-lg, 0 20px 50px rgba(0,0,0,.25))' }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ds-t1)', marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>{children}</div>
}

function Footer({ onClose, onSave, saving }: { onClose: () => void; onSave: () => void; saving: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
      <button onClick={onClose} style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
      <button onClick={onSave} disabled={saving} style={{ height: 32, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--ds-blue, #2563eb)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  )
}

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
                style={{ ...input, paddingLeft: 30 }} />
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

const card: React.CSSProperties = { background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, boxShadow: 'var(--sh-sm)', padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }

// ── Customers ────────────────────────────────────────────────────────────────

export function CustomersPage() {
  const dir = useDirectory()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CustomerRecord | 'new' | null>(null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.customers.filter((c) => !q || [c.name, c.contactName, c.contactEmail].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [dir.customers, query])

  const remove = async (c: CustomerRecord) => {
    if (!window.confirm(`Delete customer "${c.name}"? Loads keep their typed name; only the directory entry goes.`)) return
    try { await dir.removeCustomer(c.id); toast.success('Customer deleted') }
    catch (e) { toast.error(`Couldn't delete: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  return (
    <PageShell title="Customers" icon={<Building2 size={18} />} count={dir.customers.length}
      sub="Every customer and their contact, typed once. Names suggest on the Load form's Customer field."
      query={query} setQuery={setQuery} onAdd={() => setEditing('new')} onRefresh={dir.refresh}>
      {dir.loading && rows.length === 0 ? <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ ...card, justifyContent: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>No customers yet — add the first one.</div>
        : rows.map((c) => (
          <div key={c.id} style={card}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ds-t1)' }}>{c.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 3 }}>
                {c.contactName || <span style={{ color: 'var(--ds-t3)' }}>no contact yet</span>}
                {c.contactEmail && <span style={{ color: 'var(--ds-t3)' }}> · {c.contactEmail}</span>}
                {c.contactPhone && <span style={{ color: 'var(--ds-t3)' }}> · {c.contactPhone}</span>}
              </div>
              {c.notes && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>{c.notes}</div>}
            </div>
            <button onClick={() => setEditing(c)} title="Edit" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Pencil size={14} /></button>
            <button onClick={() => remove(c)} title="Delete" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Trash2 size={14} /></button>
          </div>
        ))}
      {editing && (
        <CustomerModal
          initial={editing === 'new' ? undefined : editing}
          onSave={async (v) => {
            if (editing === 'new') { await dir.addCustomer(v); toast.success('Customer added') }
            else { await dir.saveCustomer(editing.id, v); toast.success('Customer saved') }
            setEditing(null)
          }}
          onClose={() => setEditing(null)} />
      )}
    </PageShell>
  )
}

function CustomerModal({ initial, onSave, onClose }: {
  initial?: CustomerRecord
  onSave: (v: Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}) {
  const [f, setF] = useState({ name: initial?.name ?? '', contactName: initial?.contactName ?? '', contactEmail: initial?.contactEmail ?? '', contactPhone: initial?.contactPhone ?? '', notes: initial?.notes ?? '' })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))
  const save = async () => {
    if (!f.name.trim()) { toast.error('Customer name is required'); return }
    setSaving(true)
    try { await onSave({ name: f.name.trim(), contactName: f.contactName.trim() || null, contactEmail: f.contactEmail.trim() || null, contactPhone: f.contactPhone.trim() || null, notes: f.notes.trim() || null }) }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }
  return (
    <Modal title={initial ? 'Edit customer' : 'Add customer'} onClose={onClose}>
      <div style={{ marginBottom: 10 }}><span style={label}>Customer name *</span><input style={input} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="BATORY FOODS" /></div>
      <Row2>
        <div><span style={label}>Contact name</span><input style={input} value={f.contactName} onChange={(e) => set('contactName', e.target.value)} /></div>
        <div><span style={label}>Contact phone</span><input style={input} value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} /></div>
      </Row2>
      <div style={{ marginBottom: 10 }}><span style={label}>Contact email</span><input style={input} value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} placeholder="dispatch@customer.com" /></div>
      <div><span style={label}>Notes</span><input style={input} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      <Footer onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  )
}

// ── Locations ────────────────────────────────────────────────────────────────

export function LocationsPage() {
  const dir = useDirectory()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<LocationRecord | 'new' | null>(null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.locations.filter((l) => !q || [l.name, l.city, l.customerName, l.apptContactEmail].some((v) => (v ?? '').toLowerCase().includes(q)))
  }, [dir.locations, query])

  const remove = async (l: LocationRecord) => {
    if (!window.confirm(`Delete location "${l.name}"?`)) return
    try { await dir.removeLocation(l.id); toast.success('Location deleted') }
    catch (e) { toast.error(`Couldn't delete: ${e instanceof Error ? e.message : 'unknown error'}`) }
  }

  return (
    <PageShell title="Locations" icon={<MapPin size={18} />} count={dir.locations.length}
      sub="Every facility and its APPOINTMENT contact — who you email to request or book an appt. Names suggest on the Load form's facility fields."
      query={query} setQuery={setQuery} onAdd={() => setEditing('new')} onRefresh={dir.refresh}>
      {dir.loading && rows.length === 0 ? <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ ...card, justifyContent: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>No locations yet — add the first one.</div>
        : rows.map((l) => (
          <div key={l.id} style={card}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ds-t1)' }}>
                {l.name}
                {l.city && <span style={{ fontWeight: 500, color: 'var(--ds-t3)' }}> — {l.city}</span>}
                {l.customerName && <span style={{ fontSize: 10.5, fontWeight: 700, marginLeft: 8, padding: '1px 6px', borderRadius: 5, background: 'var(--ds-blue-soft, #eff6ff)', color: '#0369a1' }}>{l.customerName}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ds-t2)', marginTop: 3 }}>
                {l.apptContactEmail || l.apptContactName
                  ? <>Appt contact: {l.apptContactName}{l.apptContactEmail && <span style={{ color: 'var(--ds-t3)' }}> · {l.apptContactEmail}</span>}{l.apptContactPhone && <span style={{ color: 'var(--ds-t3)' }}> · {l.apptContactPhone}</span>}</>
                  : <span style={{ color: '#b45309' }}>no appointment contact yet</span>}
              </div>
              {l.notes && <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 3 }}>{l.notes}</div>}
            </div>
            <button onClick={() => setEditing(l)} title="Edit" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Pencil size={14} /></button>
            <button onClick={() => remove(l)} title="Delete" style={{ background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer' }}><Trash2 size={14} /></button>
          </div>
        ))}
      {editing && (
        <LocationModal
          initial={editing === 'new' ? undefined : editing}
          customers={dir.customers.map((c) => c.name)}
          onSave={async (v) => {
            if (editing === 'new') { await dir.addLocation(v); toast.success('Location added') }
            else { await dir.saveLocation(editing.id, v); toast.success('Location saved') }
            setEditing(null)
          }}
          onClose={() => setEditing(null)} />
      )}
    </PageShell>
  )
}

function LocationModal({ initial, customers, onSave, onClose }: {
  initial?: LocationRecord
  customers: string[]
  onSave: (v: Omit<LocationRecord, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  onClose: () => void
}) {
  const [f, setF] = useState({
    name: initial?.name ?? '', city: initial?.city ?? '', customerName: initial?.customerName ?? '',
    apptContactName: initial?.apptContactName ?? '', apptContactEmail: initial?.apptContactEmail ?? '',
    apptContactPhone: initial?.apptContactPhone ?? '', notes: initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))
  const save = async () => {
    if (!f.name.trim()) { toast.error('Location name is required'); return }
    setSaving(true)
    try { await onSave({ name: f.name.trim(), city: f.city.trim() || null, customerName: f.customerName.trim() || null, apptContactName: f.apptContactName.trim() || null, apptContactEmail: f.apptContactEmail.trim() || null, apptContactPhone: f.apptContactPhone.trim() || null, notes: f.notes.trim() || null }) }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); setSaving(false) }
  }
  return (
    <Modal title={initial ? 'Edit location' : 'Add location'} onClose={onClose}>
      <Row2>
        <div><span style={label}>Facility name *</span><input style={input} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="BATORY'S OAKLEY CHICAGO" /></div>
        <div><span style={label}>City, State</span><input style={input} value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="CHICAGO, IL" /></div>
      </Row2>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Customer</span>
        <input style={input} value={f.customerName} onChange={(e) => set('customerName', e.target.value)} list="dir-customers" placeholder="BATORY FOODS" />
        <datalist id="dir-customers">{customers.map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      <Row2>
        <div><span style={label}>Appt contact name</span><input style={input} value={f.apptContactName} onChange={(e) => set('apptContactName', e.target.value)} /></div>
        <div><span style={label}>Appt contact phone</span><input style={input} value={f.apptContactPhone} onChange={(e) => set('apptContactPhone', e.target.value)} /></div>
      </Row2>
      <div style={{ marginBottom: 10 }}><span style={label}>Appt contact email</span><input style={input} value={f.apptContactEmail} onChange={(e) => set('apptContactEmail', e.target.value)} placeholder="appointments@facility.com" /></div>
      <div><span style={label}>Notes</span><input style={input} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      <Footer onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  )
}
