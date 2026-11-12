/**
 * Shipments › Intake › one load: the source e-mail on the left, the draft fields on the right.
 * Every field shows how sure the automation was; the Move-to-active button states exactly what is
 * still missing. The server runs the same gate again, so this page only decides what to show.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { OwnFleetDriverPicker } from '@/components/OwnFleetDriverPicker'
import { RepPicker } from '@/components/RepPicker'
import { useOwnFleetRoster } from '@/hooks/useOwnFleetRoster'
import {
  TmsAlert, TmsButton, TmsCard, TmsDetailSplit, TmsDialog, TmsField, TmsInput, TmsPage, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import {
  dismissIntake, dismissWorkflowRun, getTmsSettings, getWorkflowRun, linkWorkflowRun, listCustomers,
  moveIntakeToActive, saveIntakeDraft,
} from '@/lib/apiClient'
import { hasBillToParties, requiredFieldLabel } from '@/lib/flowDefaults'
import { findCustomerMatches } from '@/lib/tmsDirectory'
import { Typeahead, type TypeaheadItem } from '@/features/shipments/form/cards/Typeahead'
import { SHIPMENT_TYPES } from '@/lib/shipmentTypes'
import { canMoveToActive, ensureRequiredStops, fieldStatusOf, intakeFieldKeys, intakeRequired, patchIntakeFields, withCustomerDefaults } from '@/lib/intakeLoad'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import type { IntakeFields, IntakeLoadRecord, IntakeMeta, IntakeStop } from '@/types/intake'
import { IntakeFieldRow } from './IntakeFieldRow'
import { SourceEmailCard } from './SourceEmailCard'
import { duplicateGroups } from '@/lib/intakeDuplicates'
import { DeleteIntakeDialog, DuplicateNotice } from './DuplicateParts'
import { useIntakeLoad, useIntakeLoads } from './useIntakeLoads'
import { useIntakePermissions } from './useIntakePermissions'
import './intake.css'

const CONFLICT = /changed while you were editing/i
/** The required-field catalog key -> the draft field it is entered in. */
const CATALOG_FIELD: Record<string, string> = {
  billTo: 'billToId', customerRate: 'customerRateCents', poNumber: 'reference', pickupNumber: 'pickupNumber', deliveryNumber: 'deliveryNumber',
  salesRep: 'salesRepId', revenueDivision: 'divisionCode', equipmentType: 'equipmentType', commodity: 'commodity', weight: 'weightLb',
}
const STOP_REQUIRED = ['street', 'city', 'state', 'zip', 'date', 'time']
const STOP_FIELDS: Array<{ key: 'name' | 'street' | 'city' | 'state' | 'zip' | 'date' | 'time'; label: string; type?: string }> = [
  { key: 'name', label: 'Facility' },
  { key: 'street', label: 'Street' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'Zip' },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Appointment time', type: 'time' },
]
interface Work { fields: IntakeFields; meta: IntakeMeta; confirmed: string[] }

function emptyStop(type: IntakeStop['type']): IntakeStop {
  return { type, name: null, street: null, city: null, state: null, zip: null, date: null, time: null, instructions: null }
}

const text = (v: string): string | null => (v.trim() === '' ? null : v)
const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v))

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

interface FormProps {
  row: IntakeLoadRecord
  customers: CustomerRecord[]
  settings: TmsSettings | null
  canReview: boolean
  onRow: (row: IntakeLoadRecord) => void
  reload: () => Promise<void>
}

function ReviewForm({ row, customers, settings, canReview, onRow, reload }: FormProps) {
  const navigate = useNavigate()
  const { divisions } = useOwnershipDivisions()
  const roster = useOwnFleetRoster()
  // A pickup and a delivery are always on the page, even when the e-mail gave none.
  const [work, setWork] = useState<Work>(() => ({ fields: ensureRequiredStops(row.fields), meta: row.meta, confirmed: row.confirmed }))
  const [busy, setBusy] = useState(false)
  const [customerQuery, setCustomerQuery] = useState<string | null>(null)
  const [dismissOpen, setDismissOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { isOwnerOrAdmin } = useIntakePermissions()
  const queue = useIntakeLoads({ status: 'OPEN', enabled: row.status === 'OPEN' })
  const dupInfo = useMemo(() => duplicateGroups(queue.rows).get(row.id), [queue.rows, row.id])
  const [reason, setReason] = useState('')

  const editable = canReview && row.status === 'OPEN' && !busy
  const activeDivisions = (divisions ?? []).filter((d) => d.active)
  const customer = customers.find((c) => c.id === work.fields.customerId) ?? null

  const dirty = JSON.stringify(work.fields) !== JSON.stringify(row.fields)
    || work.confirmed.length !== row.confirmed.length
    || work.confirmed.some((k) => !row.confirmed.includes(k))

  const gate = useMemo(() => {
    const ctx = {
      settings,
      customer,
      customerActive: customer != null && customer.active !== false,
      divisionActive: activeDivisions.some((d) => d.code === work.fields.divisionCode),
    }
    return canMoveToActive({ ...work, reviewedBy: null, reviewedAt: null }, ctx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, settings, customer, divisions])
  const deferred = useMemo(() => intakeRequired(settings, customer).deferred, [settings, customer])
  const requiredFields = useMemo(() => {
    const keys = new Set<string>(['customerId', 'divisionCode'])
    for (const k of intakeRequired(settings, customer).gated) if (CATALOG_FIELD[k]) keys.add(CATALOG_FIELD[k]!)
    return keys
  }, [settings, customer])
  const isRequired = (key: string) => (key === 'billToId' && billToNotApplicable ? false : requiredFields.has(key)) || (/^stops\.\d+\.(\w+)$/.exec(key)?.[1] ? STOP_REQUIRED.includes(/^stops\.\d+\.(\w+)$/.exec(key)![1]!) : false)

  function edit(patch: Partial<Omit<IntakeFields, 'stops'>>) {
    setWork((w) => patchIntakeFields(w, patch, { add: [], remove: [] }))
  }
  function pickCustomer(id: string | null, name: string | null) {
    const picked = id ? customers.find((c) => c.id === id) : undefined
    setWork((w) => {
      const next = patchIntakeFields(w, { customerId: id, customerName: picked?.name ?? name, billToId: null }, { add: [], remove: [] })
      return withCustomerDefaults(next, picked)
    })
  }
  function editStops(stops: IntakeStop[]) {
    setWork((w) => patchIntakeFields(w, { stops }, { add: [], remove: [] }))
  }
  function editStop(i: number, key: keyof IntakeStop, value: string | null) {
    editStops(work.fields.stops.map((s, idx) => (idx === i ? { ...s, [key]: value } : s)))
  }
  function setConfirmed(keys: string[], checked: boolean) {
    setWork((w) => patchIntakeFields(w, {}, checked ? { add: keys, remove: [] } : { add: [], remove: keys }))
  }
  // A customer with no separate bill-to parties is billed itself: Bill to is not asked, and it never reads Missing.
  const billToNotApplicable = customer != null && !hasBillToParties(customer.billToParties)
  function statusOf(key: string) {
    if (key === 'billToId' && billToNotApplicable) return 'AUTO'
    return fieldStatusOf(key, work.fields, work.meta, work.confirmed)
  }
  const sourceOf = (key: string) => work.meta[key]?.source ?? null

  function fieldRow(key: string, label: string, control: ReactNode) {
    return (
      <IntakeFieldRow
        key={key}
        label={label}
        status={statusOf(key)}
        source={sourceOf(key)}
        disabled={!editable}
        required={isRequired(key)}
        onConfirm={(checked) => setConfirmed([key], checked)}
      >
        {control}
      </IntakeFieldRow>
    )
  }

  function textField(key: keyof Omit<IntakeFields, 'stops'>, label: string, kind: 'text' | 'number' = 'text') {
    const value = work.fields[key]
    return fieldRow(
      key,
      label,
      <TmsInput
        aria-label={label}
        disabled={!editable}
        type={kind === 'number' ? 'number' : 'text'}
        value={value == null ? '' : String(value)}
        onChange={(e) => edit({ [key]: kind === 'number' ? num(e.target.value) : text(e.target.value) })}
      />,
    )
  }

  async function persist(): Promise<IntakeLoadRecord> {
    const saved = await saveIntakeDraft({
      intakeId: row.id,
      expectedVersion: row.version,
      fields: work.fields,
      confirm: {
        add: work.confirmed.filter((k) => !row.confirmed.includes(k)),
        remove: row.confirmed.filter((k) => !work.confirmed.includes(k)),
      },
    })
    onRow(saved)
    return saved
  }

  async function guarded<T>(fn: () => Promise<T>, failure: string): Promise<T | undefined> {
    setBusy(true)
    try {
      return await fn()
    } catch (err) {
      const message = errorMessage(err, failure)
      toast.error(message)
      if (CONFLICT.test(message)) await reload()
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function move() {
    const done = await guarded(async () => {
      const current = dirty ? await persist() : row
      return moveIntakeToActive({ intakeId: current.id, expectedVersion: current.version })
    }, 'Could not move to active')
    if (!done) return
    // Best effort: tie the agent run to the shipment so it reads APPLIED. A failure is a toast, not an error.
    try {
      const run = await getWorkflowRun(row.runId)
      if (run) {
        const version = run.version ?? 0
        if (run.outcome === 'UNKNOWN_PARTY') await dismissWorkflowRun(run.id, 'Moved to active via intake review', version)
        else await linkWorkflowRun(run.id, { shipmentId: done.shipmentId }, version)
      }
    } catch (err) {
      toast.error(`Moved, but the agent run was not linked: ${errorMessage(err, 'unknown error')}`)
    }
    toast.success(`Moved to active as ${done.shipmentNumber}`)
    if (done.driverError) toast.error(`The shipment was created, but the driver was not booked: ${done.driverError}`)
    navigate(`/tms/shipments/${done.shipmentId}`)
  }

  async function dismiss() {
    const done = await guarded(
      () => dismissIntake({ intakeId: row.id, expectedVersion: row.version, reason: reason.trim() }),
      'Could not dismiss',
    )
    if (!done) return
    setDismissOpen(false)
    onRow(done)
    toast.success('Dismissed')
    navigate('/tms/shipments/intake')
  }

  function confirmAll() {
    const keys = intakeFieldKeys(work.fields).filter((k) => ['AUTO', 'LOW'].includes(statusOf(k)))
    if (keys.length) setConfirmed(keys, true)
  }

  function revert() {
    const { customerCandidates: _c, ...auto } = row.autoFields
    // The driver is the reviewer's own pick, not something the e-mail said: reverting keeps it.
    setWork({ fields: ensureRequiredStops({ ...auto, driverId: work.fields.driverId ?? null }), meta: row.meta, confirmed: [] })
  }

  // Pickups first, then deliveries; each stop keeps its index in the draft (provenance is keyed by it).
  const stopOrder = [...work.fields.stops.keys()].sort((a, b) => (work.fields.stops[a]!.type === work.fields.stops[b]!.type ? a - b : work.fields.stops[a]!.type === 'pickup' ? -1 : 1))
  const candidates = row.autoFields.customerCandidates ?? []
  const customerOptions = customers.filter((c) => c.active !== false)
  // Search as you type: names that contain what was typed first, then the directory's fuzzy matches.
  const customerItems = useMemo<TypeaheadItem[]>(() => {
    const q = (customerQuery ?? '').trim().toLowerCase()
    const toItem = (c: CustomerRecord): TypeaheadItem => ({ id: c.id, label: c.name })
    if (!q) return customerOptions.slice(0, 30).map(toItem)
    const words = q.split(/\s+/).filter(Boolean)
    const contains = customerOptions.filter((c) => words.every((w) => `${c.name} ${(c.aliases ?? []).join(' ')}`.toLowerCase().includes(w)))
    const seen = new Set(contains.map((c) => c.id))
    const fuzzy = findCustomerMatches(customerQuery ?? '', customerOptions).map((m) => m.record).filter((c) => !seen.has(c.id))
    return [...contains, ...fuzzy].slice(0, 30).map(toItem)
  }, [customerQuery, customerOptions])
  const readOnlyReason = row.status !== 'OPEN'
    ? `This load is ${row.status.toLowerCase()}.`
    : !canReview ? 'You can look but not change intake loads.' : null

  return (
    <TmsDetailSplit ratio="6/6" aside={<SourceEmailCard row={row} onReread={reload} />} asideSide="left">
      <div className="tms-intake-group">
        {readOnlyReason ? <TmsAlert tone="blue">{readOnlyReason}</TmsAlert> : null}
        {row.status === 'OPEN' && dupInfo ? (
          <DuplicateNotice
            row={row}
            info={dupInfo}
            isAdmin={isOwnerOrAdmin}
            canReview={canReview}
            onDelete={() => setDeleteOpen(true)}
            onChanged={(next) => { onRow(next); queue.refresh() }}
          />
        ) : null}
        <TmsCard title="Customer & billing">
          {fieldRow(
            'customerId',
            'Customer',
            <Typeahead
              ariaLabel="Customer"
              inputTestId="intake-customer"
              disabled={!editable}
              placeholder={work.fields.customerName ? `Not matched: ${work.fields.customerName}` : 'Type to search customers'}
              value={customerQuery ?? customer?.name ?? ''}
              onValueChange={setCustomerQuery}
              items={customerItems}
              onPick={(id) => { setCustomerQuery(null); pickCustomer(id || null, work.fields.customerName) }}
              onBlur={() => setCustomerQuery(null)}
            />,
          )}
          {!work.fields.customerId && candidates.length > 0 ? (
            <p className="tms-field-hint">
              Did you mean:{' '}
              {candidates.map((c) => (
                <TmsButton key={c.id} size="sm" variant="ghost" disabled={!editable} onClick={() => pickCustomer(c.id, c.name)}>
                  {c.name}
                </TmsButton>
              ))}
            </p>
          ) : null}
          {fieldRow(
            'billToId',
            'Bill to',
            <TmsSelect aria-label="Bill to" disabled={!editable || billToNotApplicable} title={billToNotApplicable ? 'This customer has no separate bill-to party: the customer itself is billed.' : undefined} value={work.fields.billToId ?? ''} onChange={(e) => edit({ billToId: text(e.target.value) })}>
              <option value="">— customer —</option>
              {(customer?.billToParties ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </TmsSelect>,
          )}
          {fieldRow(
            'salesRepId',
            'Sales rep',
            <RepPicker value={work.fields.salesRepId} disabled={!editable} onChange={(v) => edit({ salesRepId: text(v) })} />,
          )}
          {fieldRow(
            'divisionCode',
            'Revenue division',
            <TmsSelect aria-label="Revenue division" disabled={!editable} value={work.fields.divisionCode ?? ''} onChange={(e) => edit({ divisionCode: text(e.target.value) })}>
              <option value="">— choose division —</option>
              {activeDivisions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </TmsSelect>,
          )}
          <div className="tms-intake-row" data-testid="intake-driver-row">
            <TmsField label="Driver (optional)" hint="Pick an Ivan Cartage driver to book on the load when the shipment is created.">
              <OwnFleetDriverPicker
                roster={roster}
                value={work.fields.driverId ?? ''}
                disabled={!editable}
                placeholder="No driver yet"
                testId="intake-driver"
                onChange={(d) => edit({ driverId: d?.id ?? null })}
              />
            </TmsField>
          </div>
        </TmsCard>

        <TmsCard title="Load">
          <div className="tms-intake-grid">
            {textField('reference', 'Reference / PO')}
            {fieldRow(
              'shipmentType',
              'Shipment type',
              <TmsSelect aria-label="Shipment type" disabled={!editable} value={work.fields.shipmentType ?? ''} onChange={(e) => edit({ shipmentType: text(e.target.value) })}>
                <option value="">— choose type —</option>
                {SHIPMENT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </TmsSelect>,
            )}
            {textField('equipmentType', 'Equipment')}
            {textField('commodity', 'Commodity')}
            {textField('weightLb', 'Weight (lb)', 'number')}
            {fieldRow(
              'customerRateCents',
              'Customer rate ($)',
              <TmsInput
                aria-label="Customer rate ($)"
                type="number"
                disabled={!editable}
                value={work.fields.customerRateCents == null ? '' : String(work.fields.customerRateCents / 100)}
                onChange={(e) => {
                  const dollars = num(e.target.value)
                  edit({ customerRateCents: dollars == null ? null : Math.round(dollars * 100) })
                }}
              />,
            )}
          </div>
        </TmsCard>

        {stopOrder.map((i) => {
          const stop = work.fields.stops[i]!
          const ordinal = work.fields.stops.filter((s, j) => s.type === stop.type && j <= i).length
          const title = `${stop.type === 'pickup' ? 'Pickup' : 'Delivery'} ${ordinal}`
          // The first pickup and the first delivery are mandatory: always on the page, never removable, and they carry the stop's reference number.
          const mandatory = ordinal === 1
          return (
            <TmsCard
              key={i}
              title={title}
              actions={editable && !mandatory ? (
                <TmsButton size="sm" variant="ghost" onClick={() => editStops(work.fields.stops.filter((_, j) => j !== i))}>Remove</TmsButton>
              ) : null}
            >
              <div className="tms-intake-grid">
                {mandatory ? (stop.type === 'pickup' ? textField('pickupNumber', 'Pickup #') : textField('deliveryNumber', 'Delivery #')) : null}
                {STOP_FIELDS.map((f) => fieldRow(
                  `stops.${i}.${f.key}`,
                  `${title} ${f.label.toLowerCase()}`,
                  <TmsInput
                    aria-label={`${title} ${f.label.toLowerCase()}`}
                    type={f.type ?? 'text'}
                    disabled={!editable}
                    value={stop[f.key] ?? ''}
                    onChange={(e) => editStop(i, f.key, text(e.target.value))}
                  />,
                ))}
              </div>
            </TmsCard>
          )
        })}
        {editable ? (
          <div className="tms-intake-footer">
            <TmsButton size="sm" onClick={() => editStops([...work.fields.stops, emptyStop('pickup')])}>Add pickup</TmsButton>
            <TmsButton size="sm" onClick={() => editStops([...work.fields.stops, emptyStop('delivery')])}>Add delivery</TmsButton>
          </div>
        ) : null}

        {row.status === 'OPEN' ? (
          <div className="tms-intake-needs">
            {gate.ok ? (
              <span>Ready to move to active.</span>
            ) : (
              <>
                {gate.missing.length > 0 ? <div>Needs: {gate.missing.join(', ')}</div> : null}
                {gate.problems.length > 0 || gate.unconfirmed.length > 0 ? (
                  <ul className="tms-intake-needs-list">
                    {gate.problems.map((p) => <li key={p}>{p}</li>)}
                    {gate.unconfirmed.length > 0 ? <li>Check and confirm: {gate.unconfirmed.join(', ')}</li> : null}
                  </ul>
                ) : null}
              </>
            )}
            {deferred.length > 0 ? <div>Checked later on the shipment: {deferred.map(requiredFieldLabel).join(', ')}</div> : null}
          </div>
        ) : null}

        {canReview && row.status === 'OPEN' ? (
          <div className="tms-intake-footer">
            <TmsButton size="sm" disabled={busy} onClick={confirmAll} title="Confirming fields does not review the load">Confirm all auto-filled</TmsButton>
            <TmsButton size="sm" variant="ghost" disabled={busy} onClick={revert}>Revert to e-mail</TmsButton>
            <span className="tms-intake-footer-spacer" />
            {isOwnerOrAdmin ? <TmsButton variant="destructive" data-testid="intake-delete" disabled={busy} onClick={() => setDeleteOpen(true)}>Delete</TmsButton> : null}
            <TmsButton variant="destructive" disabled={busy} onClick={() => setDismissOpen(true)}>Dismiss</TmsButton>
            <TmsButton variant="primary" disabled={busy || !gate.ok} onClick={move}>Create shipment</TmsButton>
          </div>
        ) : null}
      </div>

      <TmsDialog
        open={dismissOpen}
        onOpenChange={setDismissOpen}
        title="Dismiss this load?"
        description="It leaves the Open list. Say why so the next person knows."
        footer={(
          <div className="tms-intake-footer">
            <TmsButton size="sm" onClick={() => setDismissOpen(false)}>Cancel</TmsButton>
            <TmsButton size="sm" variant="destructive" disabled={busy || reason.trim() === ''} onClick={dismiss}>Dismiss</TmsButton>
          </div>
        )}
      >
        <TmsField label="Reason">
          <TmsTextarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </TmsField>
      </TmsDialog>
      <DeleteIntakeDialog
        row={row}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => navigate('/tms/shipments/intake')}
      />
    </TmsDetailSplit>
  )
}

export function IntakeReviewPage() {
  const { intakeId } = useParams<{ intakeId: string }>()
  const { row, loading, error, reload, setRow } = useIntakeLoad(intakeId)
  const { canReview } = useIntakePermissions()
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [settings, setSettings] = useState<TmsSettings | null>(null)

  useEffect(() => {
    let live = true
    listCustomers().then((c) => { if (live) setCustomers(c) }).catch(() => undefined)
    getTmsSettings().then((s) => { if (live) setSettings(s) }).catch(() => undefined)
    return () => { live = false }
  }, [])

  return (
    <TmsPage title={row?.subject || 'Intake load'}>
      {error ? <TmsAlert tone="red" title="Could not open this load">{error}</TmsAlert> : null}
      {loading ? <p className="tms-field-hint">Loading…</p> : null}
      {row ? (
        <ReviewForm
          key={`${row.id}:${row.version}`}
          row={row}
          customers={customers}
          settings={settings}
          canReview={canReview}
          onRow={setRow}
          reload={reload}
        />
      ) : null}
    </TmsPage>
  )
}

export default IntakeReviewPage
