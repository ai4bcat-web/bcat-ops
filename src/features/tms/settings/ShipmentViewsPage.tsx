/**
 * My Brokerage → Shipment views.
 *
 * A department view is a saved slice of the one Shipments page: its `filters` are read
 * by `applyViewFilters` on the board, its `columns` are board column keys, and its
 * `audience` decides who sees it in the sidebar. Views are data — adding a department
 * is adding a row — so this page is the whole editor. Owner and ADMIN only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  TmsBadge,
  TmsButton,
  TmsCard,
  TmsDialog,
  TmsField,
  TmsInput,
  TmsListPage,
  TmsSelect,
  TmsTextarea,
} from '@/features/tms/kit'
import { BOARD_COLUMNS, DEFAULT_COLUMN_KEYS } from '@/features/shipments/shipmentViews'
import { RepPicker } from '@/components/RepPicker'
import { useAuth } from '@/hooks/useAuth'
import {
  archiveShipmentView,
  listOwnershipDivisions,
  listShipmentViews,
  saveShipmentView,
} from '@/lib/apiClient'
import { validateView } from '@/lib/shipmentViewDefs'
import { ROLES, ROLE_LABELS } from '@/lib/roles'
import { SHIPMENT_STATUSES } from '@/lib/shipmentStatus'
import type { OwnershipDivisionRecord, ShipmentStatus, ShipmentViewRecord } from '@/types/tms'
import { divisionOptions, subdivisionOptions } from './taxonomyDrafts'
import {
  AP_STATUSES,
  AR_STATUSES,
  CARRIER_TYPES,
  DOCS_STATES,
  PICKUP_WINDOWS,
  TRACKING_STATES,
  blankViewDraft,
  draftSlug,
  draftToViewInput,
  viewToDraft,
} from './viewDraft'
import type { ViewDraft, ViewFilterDraft } from './viewDraft'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A boxed list of checkboxes — the one multi-select shape this editor uses. */
function CheckList({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string
  options: ReadonlyArray<{ value: string; label: string }>
  selected: readonly string[]
  onChange: (next: string[]) => void
}) {
  return (
    <fieldset style={{ border: '1px solid var(--tms-border)', borderRadius: 6, padding: 8, margin: 0 }}>
      <legend className="tms-field-label">{legend}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 150, overflowY: 'auto' }}>
        {options.length === 0 ? <span className="tms-muted">Nothing to choose.</span> : null}
        {options.map((option) => (
          <label key={option.value} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, option.value]
                    : selected.filter((v) => v !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function ViewDialog({
  draft,
  divisions,
  errors,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  draft: ViewDraft
  divisions: OwnershipDivisionRecord[]
  errors: string[]
  busy: boolean
  onChange: (next: ViewDraft) => void
  onClose: () => void
  onSave: () => void
}) {
  const divisionChoices = useMemo(() => divisionOptions(divisions), [divisions])
  const subdivisionChoices = useMemo(() => subdivisionOptions(divisions), [divisions])
  const slug = draftSlug(draft)

  const patchFilters = (patch: Partial<ViewFilterDraft>) =>
    onChange({ ...draft, filters: { ...draft.filters, ...patch } })

  return (
    <TmsDialog
      open
      onOpenChange={(next) => { if (!next) onClose() }}
      title={draft.id ? `Edit ${draft.name}` : 'Add view'}
      className="tms-dialog-xl"
      footer={
        <>
          <TmsButton onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save view'}
          </TmsButton>
        </>
      }
    >
      {errors.length > 0 ? (
        <ul className="tms-field-error" style={{ margin: '0 0 12px', paddingLeft: 18 }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="tms-grid tms-grid-3">
        <TmsField label="Name" hint={slug ? `/tms/shipments/view/${slug}` : 'The slug comes from the name.'}>
          <TmsInput value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </TmsField>
        <TmsField label="Department">
          <TmsInput value={draft.department} onChange={(e) => onChange({ ...draft, department: e.target.value })} />
        </TmsField>
        <TmsField label="Sort order">
          <TmsInput
            type="number"
            value={String(draft.sortOrder)}
            onChange={(e) => onChange({ ...draft, sortOrder: Number(e.target.value) || 0 })}
          />
        </TmsField>
      </div>

      <TmsField label="Description" className="tms-view-desc">
        <TmsTextarea
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </TmsField>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => onChange({ ...draft, isDefault: e.target.checked })}
          />
          Default view
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => onChange({ ...draft, active: e.target.checked })}
          />
          Active
        </label>
      </div>

      <h3 style={{ margin: '16px 0 8px' }}>Audience</h3>
      <div className="tms-grid tms-grid-3">
        <CheckList
          legend="Roles"
          options={ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
          selected={draft.audienceRoles}
          onChange={(audienceRoles) => onChange({ ...draft, audienceRoles })}
        />
        <TmsField label="Groups" hint="Cognito group names, comma separated — e.g. page-tms.">
          <TmsInput
            value={draft.audienceGroups.join(', ')}
            onChange={(e) =>
              onChange({
                ...draft,
                audienceGroups: e.target.value.split(',').map((g) => g.trim()).filter(Boolean),
              })
            }
          />
        </TmsField>
        <CheckList
          legend="Divisions (only people who work in one see the view)"
          options={divisionChoices}
          selected={draft.audienceDivisions}
          onChange={(audienceDivisions) => onChange({ ...draft, audienceDivisions })}
        />
      </div>

      <h3 style={{ margin: '16px 0 8px' }}>Filters</h3>
      <div className="tms-grid tms-grid-3">
        <CheckList
          legend="Divisions"
          options={divisionChoices}
          selected={draft.filters.divisions}
          onChange={(divisionsNext) => patchFilters({ divisions: divisionsNext })}
        />
        <CheckList
          legend="Subdivisions"
          options={subdivisionChoices}
          selected={draft.filters.subdivisions}
          onChange={(subdivisions) => patchFilters({ subdivisions })}
        />
        <CheckList
          legend="Statuses"
          options={SHIPMENT_STATUSES.map((status) => ({ value: status, label: status.replace(/_/g, ' ') }))}
          selected={draft.filters.statuses}
          onChange={(statuses) => patchFilters({ statuses: statuses as ShipmentStatus[] })}
        />
      </div>

      <div className="tms-grid tms-grid-4" style={{ marginTop: 12 }}>
        <TmsField label="Carrier type">
          <TmsSelect
            value={draft.filters.carrierType}
            placeholder="Any"
            onChange={(e) => patchFilters({ carrierType: e.target.value as ViewFilterDraft['carrierType'] })}
            options={CARRIER_TYPES.map((o) => ({ value: o.value, label: o.label }))}
          />
        </TmsField>
        <TmsField label="Pickup window">
          <TmsSelect
            value={draft.filters.pickupWindow}
            placeholder="Any"
            onChange={(e) => patchFilters({ pickupWindow: e.target.value as ViewFilterDraft['pickupWindow'] })}
            options={PICKUP_WINDOWS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </TmsField>
        <TmsField label="Documents">
          <TmsSelect
            value={draft.filters.docsState}
            placeholder="Any"
            onChange={(e) => patchFilters({ docsState: e.target.value as ViewFilterDraft['docsState'] })}
            options={DOCS_STATES.map((o) => ({ value: o.value, label: o.label }))}
          />
        </TmsField>
        <TmsField label="Tracking">
          <TmsSelect
            value={draft.filters.trackingState}
            placeholder="Any"
            onChange={(e) => patchFilters({ trackingState: e.target.value as ViewFilterDraft['trackingState'] })}
            options={TRACKING_STATES.map((o) => ({ value: o.value, label: o.label }))}
          />
        </TmsField>
      </div>

      <div className="tms-grid tms-grid-3" style={{ marginTop: 12 }}>
        <CheckList
          legend="AR statuses"
          options={AR_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
          selected={draft.filters.arStatuses}
          onChange={(arStatuses) => patchFilters({ arStatuses: arStatuses as ViewFilterDraft['arStatuses'] })}
        />
        <CheckList
          legend="AP statuses"
          options={AP_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
          selected={draft.filters.apStatuses}
          onChange={(apStatuses) => patchFilters({ apStatuses: apStatuses as ViewFilterDraft['apStatuses'] })}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <TmsField label="Sales rep">
            <RepPicker value={draft.filters.repId} onChange={(repId) => patchFilters({ repId })} allowUnknown />
          </TmsField>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={draft.filters.quoteToBooked}
              onChange={(e) => patchFilters({ quoteToBooked: e.target.checked })}
            />
            Only shipments that came from a quote
          </label>
          <TmsField label="Search text" hint="Matches the board's own search box.">
            <TmsInput
              value={draft.filters.search}
              onChange={(e) => patchFilters({ search: e.target.value })}
            />
          </TmsField>
        </div>
      </div>

      <h3 style={{ margin: '16px 0 8px' }}>Columns and sort</h3>
      <CheckList
        legend="Columns"
        options={BOARD_COLUMNS.map((c) => ({ value: c.key, label: c.label }))}
        selected={draft.columns}
        onChange={(columns) => onChange({ ...draft, columns })}
      />
      <div className="tms-grid tms-grid-2" style={{ marginTop: 12 }}>
        <TmsField label="Sort by">
          <TmsSelect
            value={draft.sortKey}
            placeholder="The board's own order"
            onChange={(e) => onChange({ ...draft, sortKey: e.target.value })}
            options={BOARD_COLUMNS.map((c) => ({ value: c.key, label: c.label }))}
          />
        </TmsField>
        <TmsField label="Direction">
          <TmsSelect
            value={draft.sortDir}
            onChange={(e) => onChange({ ...draft, sortDir: e.target.value === 'desc' ? 'desc' : 'asc' })}
            options={[
              { value: 'asc', label: 'Ascending' },
              { value: 'desc', label: 'Descending' },
            ]}
          />
        </TmsField>
      </div>
    </TmsDialog>
  )
}

export function ShipmentViewsPage() {
  const { isOwner, isAdmin } = useAuth()
  const allowed = isOwner || isAdmin

  const [views, setViews] = useState<ShipmentViewRecord[]>([])
  const [divisions, setDivisions] = useState<OwnershipDivisionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [draft, setDraft] = useState<ViewDraft | null>(null)
  const [draftErrors, setDraftErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain.
  const load = useCallback(
    () =>
      Promise.all([listShipmentViews(), listOwnershipDivisions()])
        .then(([nextViews, nextDivisions]) => {
          setViews(nextViews)
          setDivisions(nextDivisions)
          setListError(null)
        })
        .catch((err: unknown) => setListError(messageOf(err)))
        .finally(() => setLoading(false)),
    [],
  )

  // A caller who may not edit renders the notice below, so `loading` never matters there.
  useEffect(() => {
    if (allowed) void load()
  }, [allowed, load])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const sorted = [...views].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    if (needle === '') return sorted
    return sorted.filter((v) =>
      `${v.name} ${v.department ?? ''} ${v.slug}`.toLowerCase().includes(needle),
    )
  }, [views, search])

  if (!allowed) {
    return (
      <div className="tms-page">
        <TmsCard>
          <p className="tms-muted">
            Shipment views are edited by the owner and the ADMIN group. Ask one of them for a new department view.
          </p>
        </TmsCard>
      </div>
    )
  }

  const save = async () => {
    if (!draft) return
    const input = draftToViewInput(draft)
    const errors = validateView(input)
    if (errors.length) {
      setDraftErrors(errors)
      return
    }
    setDraftErrors([])
    setSaving(true)
    try {
      await saveShipmentView(input)
      setDraft(null)
      await load()
    } catch (err) {
      setDraftErrors([messageOf(err)])
    } finally {
      setSaving(false)
    }
  }

  const archive = async (view: ShipmentViewRecord) => {
    setListError(null)
    try {
      await archiveShipmentView({ id: view.id })
      await load()
    } catch (err) {
      setListError(messageOf(err))
    }
  }

  const audienceOf = (view: ShipmentViewRecord): string => {
    const parts = [
      ...(view.audience?.roles ?? []).map((role) => ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role),
      ...(view.audience?.groups ?? []),
    ]
    const who = parts.length ? parts.join(', ') : 'Everyone'
    // Divisions narrow whoever the roles and groups admit, so the column reads as a
    // sentence: "Everyone in ASSETS" is a smaller audience than "Everyone".
    const divisions = view.audience?.divisions ?? []
    return divisions.length ? `${who} in ${divisions.join(', ')}` : who
  }

  return (
    <div className="tms-page">
      {listError ? <p className="tms-field-error">{listError}</p> : null}
      {/* The host page (My Brokerage) carries the h1, so the list is embedded and the
          primary pill lives here instead of in the title row it no longer has. */}
      <div className="tms-page-actions">
        <TmsButton
          variant="primary"
          onClick={() => {
            setDraftErrors([])
            setDraft(blankViewDraft(DEFAULT_COLUMN_KEYS, (views.length + 1) * 10))
          }}
        >
          <Plus size={16} aria-hidden="true" /> Add view
        </TmsButton>
      </div>
      <TmsListPage<ShipmentViewRecord>
        title="Shipment views"
        embedded
        search={{ value: search, onChange: setSearch, placeholder: 'Search views' }}
        onRefresh={() => void load()}
        rows={rows}
        rowKey={(view) => view.id}
        emptyText={loading ? 'Loading…' : 'No department views yet — add the first one.'}
        page={{ from: rows.length ? 1 : 0, to: rows.length, total: rows.length, pageSize: rows.length || 20 }}
        columns={[
          { key: 'name', header: 'NAME', render: (view) => view.name },
          { key: 'department', header: 'DEPARTMENT', render: (view) => view.department ?? '—' },
          { key: 'slug', header: 'SLUG', render: (view) => view.slug },
          { key: 'audience', header: 'AUDIENCE', render: audienceOf },
          {
            key: 'isDefault',
            header: 'DEFAULT',
            render: (view) => (view.isDefault ? <TmsBadge tone="blue">Default</TmsBadge> : null),
          },
          {
            key: 'active',
            header: 'ACTIVE',
            render: (view) => (
              <TmsBadge tone={view.active ? 'green' : 'gray'}>{view.active ? 'Active' : 'Archived'}</TmsBadge>
            ),
          },
          { key: 'sortOrder', header: 'ORDER', render: (view) => String(view.sortOrder) },
          {
            key: 'actions',
            header: '',
            render: (view) => (
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
                <Link to={`/tms/shipments/view/${view.slug}`}>Open view</Link>
                <TmsButton
                  size="sm"
                  onClick={() => {
                    setDraftErrors([])
                    setDraft(viewToDraft(view, DEFAULT_COLUMN_KEYS))
                  }}
                >
                  Edit {view.slug}
                </TmsButton>
                <TmsButton size="sm" disabled={!view.active} onClick={() => void archive(view)}>
                  Archive {view.slug}
                </TmsButton>
              </span>
            ),
          },
        ]}
      />
      {draft ? (
        <ViewDialog
          draft={draft}
          divisions={divisions}
          errors={draftErrors}
          busy={saving}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  )
}

export default ShipmentViewsPage
