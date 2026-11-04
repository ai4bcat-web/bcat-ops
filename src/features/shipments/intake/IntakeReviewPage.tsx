/**
 * Shipments › Intake › one load: the source e-mail on the left, the draft fields on the right.
 * Every field shows how sure the automation was; the Move-to-active button states exactly what is
 * still missing. The server runs the same gate again, so this page only decides what to show.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { RepPicker } from '@/components/RepPicker'
import {
  TmsAlert, TmsButton, TmsCard, TmsDetailSplit, TmsDialog, TmsField, TmsInput, TmsPage, TmsSelect, TmsTextarea,
} from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import {
  dismissIntake, dismissWorkflowRun, getTmsSettings, getWorkflowRun, linkWorkflowRun, listCustomers,
  markIntakeReviewed, moveIntakeToActive, saveIntakeDraft,
} from '@/lib/apiClient'
import { requiredFieldLabel } from '@/lib/flowDefaults'
import { formatDateTime } from '@/lib/date'
import { canMarkReviewed, canMoveToActive, fieldStatusOf, intakeFieldKeys, intakeRequired, patchIntakeFields, withCustomerDefaults } from '@/lib/intakeLoad'
import type { CustomerRecord, TmsSettings } from '@/types/tms'
import type { IntakeFields, IntakeLoadRecord, IntakeMeta, IntakeStop } from '@/types/intake'
import { IntakeFieldRow } from './IntakeFieldRow'
import { SourceEmailCard } from './SourceEmailCard'
import { useIntakeLoad } from './useIntakeLoads'
import { useIntakePermissions } from './useIntakePermissions'
import './intake.css'

const CONFLICT = /changed while you were editing/i
const STOP_FIELDS: Array<{ key: 'name' | 'street' | 'city' | 'state' | 'zip' | 'date' | 'time'; label: string; type?: string }> = [
  { key: 'name', label: 'Facility' },
  { key: 'street', label: 'Street' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'Zip' },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Time', type: 'time' },
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
  const [work, setWork] = useState<Work>({ fields: row.fields, meta: row.meta, confirmed: row.confirmed })
  const [busy, setBusy] = useState(false)
  const [dismissOpen, setDismissOpen] = useState(false)
  const [reason, setReason] = useState('')

  const editable = canReview && row.status === 'OPEN' && !busy
  const activeDivisions = (divisions ?? []).filter((d) => d.active)
  const customer = customers.find((c) => c.id === work.fields.customerId) ?? null

  const dirty = JSON.stringify(work.fields) !== JSON.stringify(row.fields)
    || work.confirmed.length !== row.confirmed.length
    || work.confirmed.some((k) => !row.confirmed.includes(k))

  // A reviewed load with unsaved edits is not reviewed any more: saving clears the review server-side.
  const reviewed = !dirty && row.reviewedAt != null && row.reviewedBy != null
  const { gate, markGate } = useMemo(() => {
    const ctx = {
      settings,
      customer,
      customerActive: customer != null && customer.active !== false,
      divisionActive: activeDivisions.some((d) => d.code === work.fields.divisionCode),
    }
    return {
      gate: canMoveToActive({ ...work, reviewedBy: reviewed ? row.reviewedBy : null, reviewedAt: reviewed ? row.reviewedAt : null }, ctx),
      markGate: canMarkReviewed(work, ctx),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, settings, customer, divisions, reviewed, row.reviewedBy, row.reviewedAt])
  const reviewLine = reviewed
    ? `Reviewed by ${row.reviewedBy} · ${formatDateTime(row.reviewedAt)}`
    : row.reviewedAt != null || row.reviewedBy != null
      ? 'Saving clears the review.'
      : canReview
        ? 'Needs review — check the fields, then Mark reviewed.'
        : 'Not reviewed yet.'
  const deferred = useMemo(() => intakeRequired(settings, customer).deferred, [settings, customer])

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
  function statusOf(key: string) {
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

  async function save() {
    const saved = await guarded(persist, 'Could not save')
    if (saved) toast.success('Saved')
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
    navigate(`/tms/shipments/${done.shipmentId}`)
  }

  async function markReviewed() {
    const done = await guarded(async () => {
      const current = dirty ? await persist() : row
      return markIntakeReviewed({ intakeId: current.id, expectedVersion: current.version })
    }, 'Could not mark reviewed')
    if (!done) return
    onRow(done)
    toast.success('Marked reviewed')
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
    setWork({ fields: auto, meta: row.meta, confirmed: [] })
  }

  const candidates = row.autoFields.customerCandidates ?? []
  const customerOptions = customers.filter((c) => c.active !== false)
  const readOnlyReason = row.status !== 'OPEN'
    ? `This load is ${row.status.toLowerCase()}.`
    : !canReview ? 'You can look but not change intake loads.' : null

  return (
    <TmsDetailSplit ratio="6/6" aside={<SourceEmailCard row={row} />} asideSide="left">
      <div className="tms-intake-group">
        {readOnlyReason ? <TmsAlert tone="blue">{readOnlyReason}</TmsAlert> : null}
        <TmsCard title="Customer & billing">
          {fieldRow(
            'customerId',
            'Customer',
            <TmsSelect
              aria-label="Customer"
              disabled={!editable}
              value={work.fields.customerId ?? ''}
              onChange={(e) => pickCustomer(e.target.value || null, work.fields.customerName)}
            >
              <option value="">{work.fields.customerName ? `Not matched: ${work.fields.customerName}` : '— choose customer —'}</option>
              {customerOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </TmsSelect>,
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
            <TmsSelect aria-label="Bill to" disabled={!editable} value={work.fields.billToId ?? ''} onChange={(e) => edit({ billToId: text(e.target.value) })}>
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
        </TmsCard>

        <TmsCard title="Load">
          <div className="tms-intake-grid">
            {textField('reference', 'Reference / PO')}
            {textField('pickupNumber', 'Pickup #')}
            {textField('deliveryNumber', 'Delivery #')}
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

        {work.fields.stops.map((stop, i) => {
          const title = `${stop.type === 'pickup' ? 'Pickup' : 'Delivery'} ${work.fields.stops.filter((s, j) => s.type === stop.type && j <= i).length}`
          return (
            <TmsCard
              key={i}
              title={title}
              actions={editable ? (
                <TmsButton size="sm" variant="ghost" onClick={() => editStops(work.fields.stops.filter((_, j) => j !== i))}>Remove</TmsButton>
              ) : null}
            >
              <div className="tms-intake-grid">
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
                {markGate.ok && gate.needsReview ? <div>Needs review before it can move to active.</div> : null}
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
            <TmsButton variant="destructive" disabled={busy} onClick={() => setDismissOpen(true)}>Dismiss</TmsButton>
            <TmsButton disabled={busy || !dirty} onClick={save}>Save</TmsButton>
            <TmsButton disabled={busy || !markGate.ok || reviewed} onClick={markReviewed}>Mark reviewed</TmsButton>
            <TmsButton variant="primary" disabled={busy || !gate.ok} onClick={move}>Move to active</TmsButton>
          </div>
        ) : null}
        {row.status === 'OPEN' || row.reviewedAt != null ? <div className="tms-intake-review-line">{reviewLine}</div> : null}
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
