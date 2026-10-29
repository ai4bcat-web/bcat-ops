import { useEffect, useMemo, useState } from 'react'
import { Archive, Merge, Pencil, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory, type CustomerRecord, type LocationRecord } from '@/hooks/useDirectory'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsDialog,
  TmsField,
  TmsIconButton,
  TmsInput,
  TmsListPage,
  TmsSelect,
} from '@/features/tms/kit'
import type { ColumnDef, TmsTone } from '@/features/tms/kit'
import {
  graphqlErrorText,
  listDivisions,
  previewLocationMerge,
  startLocationMerge,
  resumeLocationMerge,
  listLocationMergeJobs,
  getTmsSettings,
  saveTmsSettings,
} from '@/lib/apiClient'
import { effectiveCustomerStatus, boardTab } from '@/lib/customerCredit'
import type { Division, LocationMergeJob, LocationMergePreview, TmsSettings, ChargeCodeDef, CustomerStatus } from '@/types/tms'
import { CustomerForm } from './components/CustomerForm'
import { useCustomerForm } from './components/useCustomerForm'
import { LocationForm } from './components/LocationForm'
import { useLocationForm } from './components/useLocationForm'
import { LocationDetail } from './components/LocationDetail'
import { CustomerProfile } from './components/CustomerProfile'
import { CustomerOrgDefaults } from './components/CustomerOrgDefaults'

function stripRecord<T extends { id: string; createdAt: string; updatedAt: string }>(record: T): Omit<T, 'id' | 'createdAt' | 'updatedAt'> {
  const { id, createdAt, updatedAt, ...rest } = record
  return rest as Omit<T, 'id' | 'createdAt' | 'updatedAt'>
}

const statusTones: Record<CustomerStatus, TmsTone> = {
  NEW: 'gray',
  CONTACTED: 'blue',
  QUALIFIED: 'turquoise',
  QUOTED: 'purple',
  NURTURING: 'pink',
  PENDING: 'orange',
  ACTIVE: 'green',
  DORMANT: 'orange',
  CLOSED: 'gray',
  BLOCKED: 'red',
}

const CUSTOMER_STATUSES: CustomerStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING', 'PENDING', 'ACTIVE', 'DORMANT', 'CLOSED', 'BLOCKED']

interface CustomerFilters {
  status: CustomerStatus | ''
  factored: '' | 'yes' | 'no'
  archived: '' | 'yes' | 'no'
  division: string
}

const EMPTY_CUSTOMER_FILTERS: CustomerFilters = { status: '', factored: '', archived: '', division: '' }

export function CustomersPage() {
  const dir = useDirectory({ includeArchived: true })
  const { isAdmin, user } = useAuth()
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<CustomerFilters>(EMPTY_CUSTOMER_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [editing, setEditing] = useState<CustomerRecord | 'new' | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [divisions, setDivisions] = useState<Division[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  const [pageSize, setPageSize] = useState(50)

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
      .filter((c) => (filters.status ? c.status === filters.status : true))
      .filter((c) => (filters.factored ? (c.factored === true) === (filters.factored === 'yes') : true))
      .filter((c) => (filters.archived ? (c.active === false) === (filters.archived === 'yes') : true))
      .filter((c) => (filters.division ? c.defaultDivisionKey === filters.division : true))
      .map((c) => ({ record: c, effective: effectiveCustomerStatus(c, null, new Date().toISOString()), tab: boardTab(effectiveCustomerStatus(c, null, new Date().toISOString())) }))
  }, [dir.customers, query, filters])

  const counts = useMemo(() => ({
    leads: rowsWithStatus.filter((r) => r.tab === 'leads').length,
    active: rowsWithStatus.filter((r) => r.tab === 'active').length,
    inactive: rowsWithStatus.filter((r) => r.tab === 'inactive').length,
  }), [rowsWithStatus])

  const [activeTab, setActiveTab] = useState<'leads' | 'active' | 'inactive'>('active')

  const visibleRows = useMemo(() => rowsWithStatus.filter((r) => r.tab === activeTab), [rowsWithStatus, activeTab])
  const pageRows = useMemo(() => visibleRows.slice(0, pageSize), [visibleRows, pageSize])

  useEffect(() => { if (dir.error) toast.error(dir.error) }, [dir.error])

  const profileCustomer = useMemo(() => dir.customers.find((c) => c.id === profileId) ?? null, [dir.customers, profileId])

  const archive = async (c: CustomerRecord) => {
    if (!window.confirm(`Archive customer "${c.name}"?\n\nShipments keep their customer name; only the directory entry is marked inactive.`)) return
    try { await dir.archiveCustomer(c); toast.success('Customer archived') } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  const saveSettings = async (patch: Parameters<typeof saveTmsSettings>[0]) => {
    if (!isAdmin) throw new Error('Admin only')
    const next = await saveTmsSettings(patch, settings?.updatedAt)
    setSettings(next)
    toast.success('Org defaults saved')
  }

  type Row = (typeof rowsWithStatus)[number]

  const columns: Array<ColumnDef<Row>> = [
    {
      key: 'name',
      header: 'CUSTOMER',
      width: 240,
      render: ({ record: c }) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{c.name}</span>
          {c.apptWorkflow === 'BATORY' && <TmsBadge tone="blue">BATORY</TmsBadge>}
          {c.active === false && <TmsBadge>ARCHIVED</TmsBadge>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'STATUS',
      width: 150,
      render: ({ record: c, effective }) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {c.status ? <TmsBadge tone={statusTones[c.status]}>{c.status}</TmsBadge> : <span className="tms-muted">—</span>}
          {c.status && effective !== c.status && <span className="tms-muted" style={{ fontSize: 11 }}>(effective {effective})</span>}
        </span>
      ),
    },
    { key: 'contact', header: 'CONTACT', width: 160, render: ({ record: c }) => c.contactName || <span className="tms-muted">no contact yet</span> },
    { key: 'email', header: 'EMAIL', width: 200, render: ({ record: c }) => c.contactEmail ?? '—' },
    { key: 'phone', header: 'PHONE', width: 140, render: ({ record: c }) => c.contactPhone ?? '—' },
    { key: 'mc', header: 'MC', width: 100, render: ({ record: c }) => c.mcNumber ?? '—' },
    { key: 'dot', header: 'DOT', width: 100, render: ({ record: c }) => c.dotNumber ?? '—' },
    {
      key: 'factored',
      header: 'FACTORED',
      width: 110,
      render: ({ record: c }) => (
        <label
          title={c.factored ? 'Factored — shipments need an MC and both ZIPs' : 'Not factored — no MC or ZIP needed to book'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={c.factored === true}
            onChange={(e) => void dir.saveCustomer(c, { factored: e.target.checked })}
            aria-label={`${c.name} is factored`}
          />
          {c.factored ? 'Yes' : 'No'}
        </label>
      ),
    },
    {
      key: 'billing',
      header: 'BILLING',
      width: 220,
      render: ({ record: c }) => [c.billingContactName, c.billingEmail, c.billingAddress?.city].filter(Boolean).join(' · ') || '—',
    },
    {
      key: 'actions',
      header: '',
      width: 80,
      render: ({ record: c }) => (
        <span style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <TmsIconButton shape="plain" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setEditing(c)}><Pencil size={14} /></TmsIconButton>
          {isAdmin && (
            <TmsIconButton shape="plain" aria-label={`Archive ${c.name}`} title="Archive" onClick={() => void archive(c)}><Archive size={14} /></TmsIconButton>
          )}
        </span>
      ),
    },
  ]

  const chips = [
    { key: 'status', label: 'Status is', value: filters.status || null, onClick: () => setFiltersOpen(true) },
    { key: 'factored', label: 'Factored is', value: filters.factored ? (filters.factored === 'yes' ? 'Yes' : 'No') : null, onClick: () => setFiltersOpen(true) },
    { key: 'archived', label: 'Archived is', value: filters.archived ? (filters.archived === 'yes' ? 'Yes' : 'No') : null, onClick: () => setFiltersOpen(true) },
    {
      key: 'division',
      label: 'Division is',
      value: filters.division ? (divisions.find((d) => d.key === filters.division)?.name ?? filters.division) : null,
      onClick: () => setFiltersOpen(true),
    },
  ]

  return (
    <>
      <TmsListPage<Row>
        title="Customers"
        primaryAction={{ label: 'Customer', onClick: () => setEditing('new') }}
        actions={isAdmin ? (
          <TmsIconButton aria-label="Organization defaults" title="Organization defaults" onClick={() => setShowDefaults(true)}>
            <Settings2 size={16} />
          </TmsIconButton>
        ) : null}
        search={{ value: query, onChange: setQuery, placeholder: 'Search customers' }}
        onRefresh={dir.refresh}
        filterChips={chips}
        onAddFilter={() => setFiltersOpen(true)}
        quickTabs={{
          tabs: [
            { key: 'leads', label: 'Leads', count: counts.leads },
            { key: 'active', label: 'Active', count: counts.active },
            { key: 'inactive', label: 'Inactive', count: counts.inactive },
          ],
          active: activeTab,
          onSelect: (key) => setActiveTab(key as 'leads' | 'active' | 'inactive'),
        }}
        columns={columns}
        rows={pageRows}
        rowKey={(row) => row.record.id}
        onRowClick={(row) => setProfileId(row.record.id)}
        page={{ from: pageRows.length === 0 ? 0 : 1, to: pageRows.length, total: visibleRows.length, pageSize, onPageSize: setPageSize }}
        emptyText={dir.loading ? 'Loading customers…' : 'No customers match this tab and these filters.'}
        onClearFilters={() => { setQuery(''); setFilters(EMPTY_CUSTOMER_FILTERS) }}
      />

      <TmsDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filter customers"
        footer={
          <>
            <TmsButton onClick={() => setFilters(EMPTY_CUSTOMER_FILTERS)}>Clear</TmsButton>
            <TmsButton variant="primary" onClick={() => setFiltersOpen(false)}>Done</TmsButton>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <TmsField label="Status is">
            <TmsSelect
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as CustomerStatus | '' })}
              placeholder="Any"
              options={CUSTOMER_STATUSES.map((s) => ({ value: s, label: s }))}
            />
          </TmsField>
          <TmsField label="Factored is">
            <TmsSelect
              value={filters.factored}
              onChange={(e) => setFilters({ ...filters, factored: e.target.value as '' | 'yes' | 'no' })}
              placeholder="Any"
              options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
            />
          </TmsField>
          <TmsField label="Archived is">
            <TmsSelect
              value={filters.archived}
              onChange={(e) => setFilters({ ...filters, archived: e.target.value as '' | 'yes' | 'no' })}
              placeholder="Any"
              options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
            />
          </TmsField>
          <TmsField label="Division is">
            <TmsSelect
              value={filters.division}
              onChange={(e) => setFilters({ ...filters, division: e.target.value })}
              placeholder="Any"
              options={divisions.map((d) => ({ value: d.key, label: d.name }))}
            />
          </TmsField>
        </div>
      </TmsDialog>

      {showDefaults && <CustomerOrgDefaults settings={settings} onSave={saveSettings} onClose={() => setShowDefaults(false)} />}

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
    </>
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
    <TmsDialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose() }}
      className="tms-dialog-wide"
      title={initial ? 'Edit customer' : 'Add customer'}
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</TmsButton>
        </>
      }
    >
      <CustomerForm value={value} set={set} errors={errors} divisions={divisions} />
    </TmsDialog>
  )
}

interface LocationFilters {
  facilityType: string
  apptRule: string
  archived: '' | 'yes' | 'no'
}

const EMPTY_LOCATION_FILTERS: LocationFilters = { facilityType: '', apptRule: '', archived: '' }
const FACILITY_TYPES = ['SHIPPER', 'RECEIVER', 'BOTH', 'YARD', 'TRUCK_STOP', 'OTHER']
const APPT_RULES = ['FCFS', 'APPT', 'EITHER']

export function LocationsPage() {
  const dir = useDirectory()
  const { isAdmin } = useAuth()
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<LocationFilters>(EMPTY_LOCATION_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [editing, setEditing] = useState<LocationRecord | 'new' | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState(50)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return dir.locations
      .filter((l) =>
        !q || [l.name, l.city, l.state, l.customerName, l.apptContactEmail, l.street, l.zip].some((v) => (v ?? '').toLowerCase().includes(q))
      )
      .filter((l) => (filters.facilityType ? l.facilityType === filters.facilityType : true))
      .filter((l) => (filters.apptRule ? l.apptRule === filters.apptRule : true))
      .filter((l) => (filters.archived ? (l.active === false) === (filters.archived === 'yes') : true))
  }, [dir.locations, query, filters])

  const pageRows = useMemo(() => rows.slice(0, pageSize), [rows, pageSize])

  useEffect(() => { if (dir.error) toast.error(dir.error) }, [dir.error])

  const open = useMemo(() => dir.locations.find((l) => l.id === openId) ?? null, [dir.locations, openId])

  const archive = async (l: LocationRecord) => {
    if (!window.confirm(`Archive location "${l.name}"?\n\nShipments keep their stop address; only the directory entry is marked inactive.`)) return
    try { await dir.archiveLocation(l); toast.success('Location archived') } catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
  }

  const columns: Array<ColumnDef<LocationRecord>> = [
    {
      key: 'name',
      header: 'FACILITY',
      width: 240,
      render: (l) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{l.name}</span>
          {l.facilityType && <TmsBadge tone="blue">{l.facilityType}</TmsBadge>}
          {l.active === false && <TmsBadge>ARCHIVED</TmsBadge>}
        </span>
      ),
    },
    {
      key: 'address',
      header: 'ADDRESS',
      width: 280,
      render: (l) =>
        [l.street, [l.city, l.state].filter(Boolean).join(', '), l.zip, l.country].filter(Boolean).join(' · ') || (
          <span className="tms-muted">no address yet</span>
        ),
    },
    { key: 'appt', header: 'APPT RULE', width: 120, render: (l) => l.apptRule ?? '—' },
    { key: 'lead', header: 'LEAD TIME', width: 110, render: (l) => (l.apptLeadTimeHours != null ? `${l.apptLeadTimeHours}h` : '—') },
    { key: 'hours', header: 'HOURS', width: 160, render: (l) => l.hours ?? '—' },
    {
      key: 'contact',
      header: 'APPT CONTACT',
      width: 220,
      render: (l) => [l.apptContactName, l.apptContactEmail, l.apptContactPhone].filter(Boolean).join(' · ') || '—',
    },
    {
      key: 'customers',
      header: 'CUSTOMERS',
      width: 220,
      render: (l) => (l.customerIds && l.customerIds.length > 0
        ? l.customerIds.map((id) => dir.customers.find((c) => c.id === id)?.name ?? id).join(', ')
        : '—'),
    },
    {
      key: 'actions',
      header: '',
      width: 80,
      render: (l) => (
        <span style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          <TmsIconButton shape="plain" aria-label={`Edit ${l.name}`} title="Edit" onClick={() => setEditing(l)}><Pencil size={14} /></TmsIconButton>
          {isAdmin && (
            <TmsIconButton shape="plain" aria-label={`Archive ${l.name}`} title="Archive" onClick={() => void archive(l)}><Archive size={14} /></TmsIconButton>
          )}
        </span>
      ),
    },
  ]

  return (
    <>
      <TmsListPage<LocationRecord>
        title="Locations"
        primaryAction={{ label: 'Location', onClick: () => setEditing('new') }}
        actions={isAdmin ? (
          <TmsIconButton aria-label="Merge locations" title="Merge locations" onClick={() => setMergeOpen(true)}>
            <Merge size={16} />
          </TmsIconButton>
        ) : null}
        search={{ value: query, onChange: setQuery, placeholder: 'Search locations' }}
        onRefresh={dir.refresh}
        filterChips={[
          { key: 'facility', label: 'Facility type is', value: filters.facilityType || null, onClick: () => setFiltersOpen(true) },
          { key: 'appt', label: 'Appt rule is', value: filters.apptRule || null, onClick: () => setFiltersOpen(true) },
          { key: 'archived', label: 'Archived is', value: filters.archived ? (filters.archived === 'yes' ? 'Yes' : 'No') : null, onClick: () => setFiltersOpen(true) },
        ]}
        onAddFilter={() => setFiltersOpen(true)}
        columns={columns}
        rows={pageRows}
        rowKey={(l) => l.id}
        onRowClick={(l) => setOpenId(l.id)}
        page={{ from: pageRows.length === 0 ? 0 : 1, to: pageRows.length, total: rows.length, pageSize, onPageSize: setPageSize }}
        emptyText={dir.loading ? 'Loading locations…' : 'No locations match these filters.'}
        onClearFilters={() => { setQuery(''); setFilters(EMPTY_LOCATION_FILTERS) }}
      />

      <TmsDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filter locations"
        footer={
          <>
            <TmsButton onClick={() => setFilters(EMPTY_LOCATION_FILTERS)}>Clear</TmsButton>
            <TmsButton variant="primary" onClick={() => setFiltersOpen(false)}>Done</TmsButton>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <TmsField label="Facility type is">
            <TmsSelect
              value={filters.facilityType}
              onChange={(e) => setFilters({ ...filters, facilityType: e.target.value })}
              placeholder="Any"
              options={FACILITY_TYPES.map((t) => ({ value: t, label: t }))}
            />
          </TmsField>
          <TmsField label="Appointment rule is">
            <TmsSelect
              value={filters.apptRule}
              onChange={(e) => setFilters({ ...filters, apptRule: e.target.value })}
              placeholder="Any"
              options={APPT_RULES.map((t) => ({ value: t, label: t }))}
            />
          </TmsField>
          <TmsField label="Archived is">
            <TmsSelect
              value={filters.archived}
              onChange={(e) => setFilters({ ...filters, archived: e.target.value as '' | 'yes' | 'no' })}
              placeholder="Any"
              options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
            />
          </TmsField>
        </div>
      </TmsDialog>

      {open && (
        <TmsDialog
          open
          onOpenChange={(v) => { if (!v) setOpenId(null) }}
          className="tms-dialog-wide"
          title={open.name}
          footer={
            <>
              <TmsButton onClick={() => setOpenId(null)}>Close</TmsButton>
              <TmsButton variant="primary" onClick={() => { setEditing(open); setOpenId(null) }}>Edit</TmsButton>
            </>
          }
        >
          <TmsCard title="Map and shipment history" flush>
            <div style={{ padding: 12 }}>
              <LocationDetail location={open} />
            </div>
          </TmsCard>
        </TmsDialog>
      )}

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
    </>
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
    <TmsDialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose() }}
      className="tms-dialog-wide"
      title={initial ? 'Edit location' : 'Add location'}
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</TmsButton>
        </>
      }
    >
      <LocationForm value={value} set={set} setAddressField={setAddressField} errors={errors} customers={customers} />
    </TmsDialog>
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
    <TmsDialog open={open} onOpenChange={(v) => { if (!v) onClose() }} title="Merge locations (admin only)">
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="tms-grid tms-grid-2">
          <TmsField label="Source">
            <TmsSelect
              value={sourceId}
              onChange={(e) => { setSourceId(e.target.value); setPreview(null) }}
              placeholder="Select source"
              options={candidates.map((l) => ({ value: l.id, label: `${l.name} · ${l.city ?? '—'}` }))}
            />
          </TmsField>
          <TmsField label="Target">
            <TmsSelect
              value={targetId}
              onChange={(e) => { setTargetId(e.target.value); setPreview(null) }}
              placeholder="Select target"
              options={candidates.map((l) => ({ value: l.id, label: `${l.name} · ${l.city ?? '—'}` }))}
            />
          </TmsField>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <TmsButton size="sm" onClick={runPreview} disabled={!canPreview || previewing}>
            {previewing ? '…' : 'Preview'}
          </TmsButton>
          <TmsButton variant="primary" size="sm" onClick={runMerge} disabled={!canPreview || previewing}>
            Start merge
          </TmsButton>
        </div>

        {preview && (
          <div className="tms-card">
            <div className="tms-card-body" style={{ fontSize: 13 }}>Shipment count: {preview.loadCount}</div>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--tms-border)', paddingTop: 12, display: 'grid', gap: 8 }}>
          <span className="tms-field-label">Resume job</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <TmsInput value={jobIdInput} onChange={(e) => setJobIdInput(e.target.value)} placeholder="Job ID" aria-label="Job ID" />
            <TmsButton size="sm" onClick={runResume}>Resume</TmsButton>
          </div>
          {job && <p className="tms-muted" style={{ fontSize: 12 }}>Job {job.id}: {job.status}</p>}
          {jobs.length > 0 && (
            <div style={{ maxHeight: 128, overflowY: 'auto', display: 'grid', gap: 4 }}>
              {jobs.map((j) => (
                <div key={j.id} className="tms-muted" style={{ fontSize: 12 }}>{j.id} · {j.status} · {j.processedCount}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </TmsDialog>
  )
}
