import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Archive, MessageSquarePlus, Merge, Pencil, Search, Settings2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useStaff } from '@/hooks/useStaff'
import { useCrmAccounts } from '@/features/crm/useCrmAccounts'
import { isCrmManager, isOverdue, kindLabel, relativeDay } from '@/features/crm/format'
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
import { TmsSegmentedTabs } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import { ClearFiltersButton, ColumnsButton, DensityToggle, DenseKpiStrip, SummaryToggle } from '@/features/tms/grid/DenseControls'
import {
  activeFilterCount,
  filterRows,
  nextSort,
  reorderKeys,
  sortDenseRows,
  type DenseColumn,
  type DenseColumnFilter,
  type DenseFilters,
} from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import type { CrmListAccountRow } from '@/lib/crm/types'
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
import { driverNotesSummary } from '@/lib/tmsDirectory'
import type { Division, LocationMergeJob, LocationMergePreview, TmsSettings, ChargeCodeDef, CustomerStatus } from '@/types/tms'
import { CustomerForm } from './components/CustomerForm'
import { useCustomerForm } from './components/useCustomerForm'
import { LocationForm } from './components/LocationForm'
import { useLocationForm } from './components/useLocationForm'
import { LocationDetail } from './components/LocationDetail'
import { CustomerProfile } from './components/CustomerProfile'
import { CustomerOrgDefaults } from './components/CustomerOrgDefaults'
import { AddNoteDialog } from './components/AddNoteDialog'

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

/** A hundred rows a page; the grid virtualises them, so the DOM holds only the rows in view. */
const PAGE_SIZE = 100

type BoardTab = 'leads' | 'active' | 'inactive'

interface CustomerRow {
  record: CustomerRecord
  effective: CustomerStatus
  tab: BoardTab
  crm: CrmListAccountRow | undefined
  ownerName: string
  teamName: string
  divisionName: string
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`
/** How many distinct billing addresses the customer has on file (the field holds a comma or semicolon list). */
const billingEmailCount = (c: CustomerRecord) => (c.billingEmail ?? '').split(/[\s,;]+/).filter((s) => s.includes('@')).length
const yesNo = (v: boolean | null | undefined) => (v === true ? 'Yes' : 'No')
const opt = (v: string | null | undefined) => (v ? [{ value: v, label: v }] : [])

const DEFAULT_COLUMNS = ['name', 'status', 'owner', 'lastTouch', 'nextStep', 'credit', 'terms', 'contact', 'city']
/** Columns fed by CRM_LIST_ACCOUNTS `withActivity`. */
const ACTIVITY_COLUMN_KEYS = ['openAr', 'lastShipment']
const ALL_COLUMN_KEYS = [
  ...DEFAULT_COLUMNS,
  'team', 'billingEmails', 'factored', 'email', 'state',
  'division', 'stage', 'nextDue', 'openTasks', 'phone', 'mc', 'dot', 'archived', 'aljexCode', 'industry', 'leadSource', 'created',
  ...ACTIVITY_COLUMN_KEYS,
]
const ACTIONS_KEY = 'actions'

const gridCatalog: Array<DenseColumn<CustomerRow>> = [
    { key: 'name', header: 'Customer', group: 'Account', text: (r) => r.record.name },
    {
      key: 'status', header: 'Status', group: 'Account', text: (r) => r.record.status ?? '', filter: 'multi',
      fixedOptions: CUSTOMER_STATUSES.map((s) => ({ value: s, label: s })), optionsOf: (r) => opt(r.record.status),
    },
    { key: 'owner', header: 'Owner', group: 'Account', text: (r) => r.ownerName, filter: 'multi', optionsOf: (r) => opt(r.ownerName) },
    { key: 'team', header: 'Team', group: 'Account', text: (r) => r.teamName, filter: 'multi', optionsOf: (r) => opt(r.teamName) },
    { key: 'division', header: 'Division', group: 'Account', text: (r) => r.divisionName, filter: 'multi', optionsOf: (r) => opt(r.divisionName) },
    { key: 'stage', header: 'CRM stage', group: 'Account', text: (r) => r.crm?.stage ?? '', filter: 'multi', optionsOf: (r) => opt(r.crm?.stage) },
    { key: 'archived', header: 'Archived', group: 'Account', text: (r) => yesNo(r.record.active === false), filter: 'multi' },
    { key: 'aljexCode', header: 'Aljex #', group: 'Account', text: (r) => r.record.aljexCode ?? '' },
    { key: 'industry', header: 'Industry', group: 'Account', text: (r) => r.record.industry ?? '', filter: 'multi', optionsOf: (r) => opt(r.record.industry) },
    { key: 'leadSource', header: 'Lead source', group: 'Account', text: (r) => r.record.leadSource ?? '', filter: 'multi', optionsOf: (r) => opt(r.record.leadSource) },
    { key: 'created', header: 'Created', group: 'Account', text: (r) => r.record.createdAt.slice(0, 10), filter: 'date', dateOf: (r) => r.record.createdAt, sortValue: (r) => r.record.createdAt },
    {
      key: 'lastTouch', header: 'Last touch', group: 'CRM',
      text: (r) => (r.crm?.lastTouchAt ? `${kindLabel(r.crm.lastTouchKind)} · ${relativeDay(r.crm.lastTouchAt)}` : ''),
      filter: 'date', dateOf: (r) => r.crm?.lastTouchAt ?? null, sortValue: (r) => r.crm?.lastTouchAt ?? null,
    },
    {
      key: 'nextStep', header: 'Next step', group: 'CRM',
      text: (r) => (r.crm?.nextStep ? `${r.crm.nextStep}${r.crm.nextStepDueAt ? ` · ${r.crm.nextStepDueAt.slice(0, 10)}` : ''}` : ''),
      sortValue: (r) => r.crm?.nextStep ?? null,
    },
    {
      key: 'nextDue', header: 'Next step due', group: 'CRM', text: (r) => r.crm?.nextStepDueAt?.slice(0, 10) ?? '',
      filter: 'date', dateOf: (r) => r.crm?.nextStepDueAt ?? null, sortValue: (r) => r.crm?.nextStepDueAt ?? null,
    },
    { key: 'openTasks', header: 'Open tasks', group: 'CRM', text: (r) => String(r.crm?.openTaskCount ?? 0), filter: 'number', numberOf: (r) => r.crm?.openTaskCount ?? 0, align: 'right' },
    {
      key: 'credit', header: 'Credit limit', group: 'Billing', text: (r) => (r.record.creditLimitCents != null ? dollars(r.record.creditLimitCents) : ''),
      filter: 'number', numberOf: (r) => (r.record.creditLimitCents != null ? r.record.creditLimitCents / 100 : null), numberUnit: '$', align: 'right',
    },
    {
      key: 'terms', header: 'Terms', group: 'Billing', text: (r) => (r.record.paymentTermsDays != null ? `Net ${r.record.paymentTermsDays}` : ''),
      filter: 'number', numberOf: (r) => r.record.paymentTermsDays ?? null, numberUnit: 'days', align: 'right',
    },
    {
      key: 'billingEmails', header: 'Billing e-mails', group: 'Billing', text: (r) => String(billingEmailCount(r.record)),
      filter: 'number', numberOf: (r) => billingEmailCount(r.record), align: 'right',
    },
    {
      key: 'openAr', header: 'Open AR', group: 'Billing', text: (r) => (r.crm?.openArCents != null ? dollars(r.crm.openArCents) : ''),
      filter: 'number', numberOf: (r) => (r.crm?.openArCents != null ? r.crm.openArCents / 100 : null), numberUnit: '$', align: 'right',
    },
    {
      key: 'lastShipment', header: 'Last shipment', group: 'Activity', text: (r) => r.crm?.lastShipmentAt?.slice(0, 10) ?? '',
      filter: 'date', dateOf: (r) => r.crm?.lastShipmentAt ?? null, sortValue: (r) => r.crm?.lastShipmentAt ?? null,
    },
    { key: 'factored', header: 'Factored', group: 'Billing', text: (r) => yesNo(r.record.factored), filter: 'multi' },
    { key: 'contact', header: 'Contact', group: 'Contact', text: (r) => r.record.contactName ?? '' },
    { key: 'email', header: 'E-mail', group: 'Contact', text: (r) => r.record.contactEmail ?? '' },
    { key: 'phone', header: 'Phone', group: 'Contact', text: (r) => r.record.contactPhone ?? '' },
    { key: 'city', header: 'City', group: 'Contact', text: (r) => r.record.billingAddress?.city ?? '' },
    { key: 'state', header: 'State', group: 'Contact', text: (r) => r.record.billingAddress?.state ?? '', filter: 'multi', optionsOf: (r) => opt(r.record.billingAddress?.state) },
    { key: 'mc', header: 'MC', group: 'Authority', text: (r) => r.record.mcNumber ?? '' },
    { key: 'dot', header: 'DOT', group: 'Authority', text: (r) => r.record.dotNumber ?? '' },
    { key: ACTIONS_KEY, header: '', text: () => '', fixed: true, filter: false, sortable: false, width: 110 },
]

export function CustomersPage() {
  const [params, setParams] = useSearchParams()
  const profileId = params.get('customer')
  // The directory's 3,000+ locations are only read by the profile's "Shipping locations" tab.
  const dir = useDirectory({ includeArchived: true, locations: profileId != null })
  const auth = useAuth()
  const { isAdmin, user } = auth
  const isManager = isCrmManager(auth)
  // Managers and admins can narrow to their own accounts; everyone else is always on their own (§5.6).
  const [scope, setScope] = useState<'mine' | 'all'>('all')
  const prefs = useDenseGridPrefs({
    gridId: 'customers',
    email: user?.email,
    defaultColumns: DEFAULT_COLUMNS,
    validKeys: ALL_COLUMN_KEYS,
    defaultSort: { key: 'name', dir: 'asc' },
  })
  // Open AR and Last shipment cost server queries, so they are fetched only while a column shows them.
  const withActivity = prefs.columns.some((k) => ACTIVITY_COLUMN_KEYS.includes(k))
  const crm = useCrmAccounts(isManager ? scope : 'mine', withActivity)
  const { nameOf } = useStaff(user?.email)
  const [noteFor, setNoteFor] = useState<CustomerRecord | null>(null)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<DenseFilters>({})
  const [editing, setEditing] = useState<CustomerRecord | 'new' | null>(null)
  // `?customer=<id>` owns which profile is open (Settings → Tracking automation links here), the way `?doc=` does elsewhere.
  const setProfileId = useCallback((id: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('customer', id); else next.delete('customer')
      return next
    }, { replace: true })
  }, [setParams])
  const [divisions, setDivisions] = useState<Division[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  useEffect(() => {
    listDivisions().then(setDivisions).catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load divisions'))
    getTmsSettings()
      .then((s) => setSettings(s))
      .catch((e: unknown) => toast.error(graphqlErrorText(e) || 'Could not load settings'))
  }, [])

  const catalog = useMemo<ChargeCodeDef[]>(() => settings?.chargeCodes ?? [], [settings])

  const teamNames = useMemo(() => new Map((settings?.teams ?? []).map((t) => [t.key, t.name])), [settings])
  const divisionNames = useMemo(() => new Map(divisions.map((d) => [d.key, d.name])), [divisions])

  const rowsWithStatus = useMemo<CustomerRow[]>(() => {
    const q = query.trim().toLowerCase()
    const visibleOnly = crm.loaded && (!isManager || scope === 'mine')
    const now = new Date().toISOString()
    return dir.customers
      .filter((c) => !visibleOnly || crm.byCustomer.has(c.id))
      .filter((c) =>
        !q || [c.name, c.contactName, c.contactEmail, c.mcNumber, c.dotNumber].some((v) => (v ?? '').toLowerCase().includes(q))
      )
      .map((c) => {
        const effective = effectiveCustomerStatus(c, null, now)
        const row = crm.byCustomer.get(c.id)
        return {
          record: c,
          effective,
          tab: boardTab(effective),
          crm: row,
          ownerName: row?.ownerId ? nameOf(row.ownerId) : '',
          teamName: c.teamKey ? (teamNames.get(c.teamKey) ?? c.teamKey) : '',
          divisionName: c.defaultDivisionKey ? (divisionNames.get(c.defaultDivisionKey) ?? c.defaultDivisionKey) : '',
        }
      })
  }, [dir.customers, query, crm.loaded, crm.byCustomer, isManager, scope, nameOf, teamNames, divisionNames])

  const counts = useMemo(() => ({
    leads: rowsWithStatus.filter((r) => r.tab === 'leads').length,
    active: rowsWithStatus.filter((r) => r.tab === 'active').length,
    inactive: rowsWithStatus.filter((r) => r.tab === 'inactive').length,
  }), [rowsWithStatus])

  const [activeTab, setActiveTab] = useState<BoardTab>('active')

  const gridColumns = useMemo(
    () => [
      ...prefs.columns.map((k) => gridCatalog.find((c) => c.key === k)).filter((c) => c != null),
      ...gridCatalog.filter((c) => c.key === ACTIONS_KEY),
    ],
    [prefs.columns],
  )
  const tabRows = useMemo(() => rowsWithStatus.filter((r) => r.tab === activeTab), [rowsWithStatus, activeTab])
  const filteredRows = useMemo(() => filterRows(tabRows, gridCatalog, filters), [tabRows, filters])
  const sortedRows = useMemo(() => sortDenseRows(filteredRows, gridCatalog, prefs.sort), [filteredRows, prefs.sort])
  const pageRows = useMemo(() => sortedRows.slice(0, pageSize), [sortedRows, pageSize])
  const setColumnFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setPageSize(PAGE_SIZE)
    setFilters((prev) => {
      const copy = { ...prev }
      if (next) copy[key] = next
      else delete copy[key]
      return copy
    })
  }, [])
  const kpis = useMemo(() => [
    { label: 'Customers', value: sortedRows.length },
    { label: 'Next step overdue', value: sortedRows.filter((r) => r.crm?.nextStep && isOverdue(r.crm.nextStepDueAt)).length, tone: 'bad' as const },
    { label: 'No owner', value: sortedRows.filter((r) => !r.ownerName).length, tone: 'warn' as const },
    { label: 'Factored', value: sortedRows.filter((r) => r.record.factored === true).length },
  ], [sortedRows])

  useEffect(() => { if (dir.error) toast.error(dir.error) }, [dir.error])

  const profileCustomer = useMemo(() => dir.customers.find((c) => c.id === profileId) ?? null, [dir.customers, profileId])

  // A link to a customer that no longer exists (or that this user cannot see) must not leave a dead param behind.
  useEffect(() => {
    if (profileId && !dir.loading && !dir.error && !profileCustomer) {
      toast.error('That customer was not found')
      setProfileId(null)
    }
  }, [profileId, profileCustomer, dir.loading, dir.error, setProfileId])

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

  const renderCell = (row: CustomerRow, key: string) => {
    const { record: c, effective, crm: crmRow } = row
    switch (key) {
      case 'name':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>{c.name}</span>
            {c.apptWorkflow === 'BATORY' && <TmsBadge tone="blue">BATORY</TmsBadge>}
            {c.active === false && <TmsBadge>ARCHIVED</TmsBadge>}
          </span>
        )
      case 'status':
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {c.status ? <TmsBadge tone={statusTones[c.status]}>{c.status}</TmsBadge> : <span className="tms-muted">—</span>}
            {c.status && effective !== c.status && <span className="tms-muted" style={{ fontSize: 11 }}>(effective {effective})</span>}
          </span>
        )
      case 'owner':
        return row.ownerName || <span className="tms-muted">—</span>
      case 'lastTouch':
        return crmRow?.lastTouchAt
          ? <span data-testid={`crm-last-touch-${c.id}`}>{kindLabel(crmRow.lastTouchKind)} · {relativeDay(crmRow.lastTouchAt)}</span>
          : <span className="tms-muted">—</span>
      case 'nextStep': {
        if (!crmRow?.nextStep) return <span className="tms-muted">—</span>
        const overdue = isOverdue(crmRow.nextStepDueAt)
        return (
          <span data-testid={`crm-next-step-${c.id}`} data-overdue={overdue ? 'true' : undefined}>
            {crmRow.nextStep}{crmRow.nextStepDueAt ? ` · ${crmRow.nextStepDueAt.slice(0, 10)}` : ''}
            {overdue && <> <TmsBadge tone="red">overdue</TmsBadge></>}
          </span>
        )
      }
      case 'factored':
        return (
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
        )
      case ACTIONS_KEY:
        return (
          <span style={{ display: 'inline-flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
            <TmsIconButton shape="plain" aria-label={`Add note to ${c.name}`} title="Add note" onClick={() => setNoteFor(c)}><MessageSquarePlus size={14} /></TmsIconButton>
            <TmsIconButton shape="plain" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setEditing(c)}><Pencil size={14} /></TmsIconButton>
            {isAdmin && (
              <TmsIconButton shape="plain" aria-label={`Archive ${c.name}`} title="Archive" onClick={() => void archive(c)}><Archive size={14} /></TmsIconButton>
            )}
          </span>
        )
      default:
        return gridCatalog.find((col) => col.key === key)?.text(row) || <span className="tms-muted">—</span>
    }
  }

  return (
    <>
      <div className="tms-dense-page">
        <div className="tms-dense-bar">
          <span className="tms-dense-title"><Users size={18} aria-hidden="true" /> Customers</span>
          <Search size={14} className="tms-muted" aria-hidden="true" />
          <TmsInput
            placeholder="Search customers"
            aria-label="Search customers"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPageSize(PAGE_SIZE) }}
            className="tms-dense-search"
          />
          <TmsSegmentedTabs
            aria-label="Customer board"
            size="sm"
            tabs={[
              { key: 'leads', label: 'Prospects', count: counts.leads },
              { key: 'active', label: 'Active', count: counts.active },
              { key: 'inactive', label: 'Inactive', count: counts.inactive },
            ]}
            active={activeTab}
            onSelect={(key) => { setActiveTab(key as BoardTab); setPageSize(PAGE_SIZE) }}
          />
          {isManager && (
            <span role="group" aria-label="Account scope" style={{ display: 'inline-flex', gap: 4 }} data-testid="crm-scope">
              <TmsButton size="sm" variant={scope === 'mine' ? 'primary' : undefined} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')} data-testid="crm-scope-mine">Mine</TmsButton>
              <TmsButton size="sm" variant={scope === 'all' ? 'primary' : undefined} aria-pressed={scope === 'all'} onClick={() => setScope('all')} data-testid="crm-scope-all">All</TmsButton>
            </span>
          )}
          <ClearFiltersButton count={activeFilterCount(filters)} onClear={() => { setFilters({}); setPageSize(PAGE_SIZE) }} />
          <span className="tms-dense-spacer" />
          <TmsButton size="sm" variant="secondary" onClick={() => void dir.refresh()}>Refresh</TmsButton>
          <ColumnsButton
            catalog={gridCatalog}
            columns={prefs.columns}
            widths={prefs.widths}
            pinned={prefs.pinned}
            onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })}
          />
          <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
          <SummaryToggle open={prefs.kpiOpen} onToggle={() => prefs.setKpiOpen(!prefs.kpiOpen)} />
          {isAdmin && (
            <TmsIconButton aria-label="Organization defaults" title="Organization defaults" onClick={() => setShowDefaults(true)}>
              <Settings2 size={16} />
            </TmsIconButton>
          )}
          <TmsButton size="sm" variant="primary" onClick={() => setEditing('new')}>Customer</TmsButton>
        </div>
        <DenseKpiStrip open={prefs.kpiOpen} items={kpis} />
        <div className="tms-dense-body">
          <DenseGrid<CustomerRow>
            aria-label="Customers"
            recentKey={`tms:customers:recent:${user?.email ?? 'anon'}`}
            resetKey={`${activeTab}|${scope}|${query}|${JSON.stringify(filters)}|${JSON.stringify(prefs.sort)}`}
            columns={gridColumns}
            rows={pageRows}
            fitRows={tabRows}
            rowKey={(r) => r.record.id}
            renderCell={renderCell}
            density={prefs.density}
            userWidths={prefs.widths}
            stickyCount={Math.max(1, prefs.pinned.length)}
            sort={prefs.sort}
            onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
            filters={filters}
            onFilterChange={setColumnFilter}
            onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
            onResize={prefs.setWidth}
            onRowClick={(r) => setProfileId(r.record.id)}
            empty={dir.loading ? 'Loading customers…' : 'No customers match this tab and these filters.'}
          />
          {sortedRows.length > pageRows.length && (
            <div className="tms-dense-bar" data-testid="customers-more">
              <span className="tms-muted">Showing {pageRows.length} of {sortedRows.length}</span>
              <TmsButton size="sm" variant="secondary" onClick={() => setPageSize((s) => s + PAGE_SIZE)}>Show next {PAGE_SIZE}</TmsButton>
            </div>
          )}
        </div>
      </div>

      {noteFor && <AddNoteDialog customerId={noteFor.id} customerName={noteFor.name} onClose={() => setNoteFor(null)} onSaved={() => void crm.refresh()} />}

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
          onClose={() => { setProfileId(null); void crm.refresh() }}
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
      key: 'driverNotes',
      header: 'DRIVER NOTES',
      width: 130,
      render: (l) => {
        const { count, newestAt } = driverNotesSummary(l.driverNotes)
        return count ? (
          <span title="Comments drivers left from the driver app">
            <b>{count}</b>{newestAt ? ` · ${new Date(newestAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
          </span>
        ) : '—'
      },
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
              <LocationDetail location={open} onRemoveNote={async (note) => { await dir.removeDriverNote(open, note); toast.success('Driver note removed') }} />
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
