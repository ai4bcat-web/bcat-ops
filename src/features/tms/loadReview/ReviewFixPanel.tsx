/**
 * Load Review fixes, in the rail (Ryne 2026-11-16: "all required fixes should be able to be made in the rail"). Each section edits
 * through the same server action the shipment editor uses (UPDATE_ORDER_DETAILS, UPDATE_STOP, SET_SHIPMENT_CUSTOMER, ASSIGN_ASSET,
 * UPSERT_CUSTOMER), so validation, version checks and audit are the editor's. After every save the drawer re-runs REVIEW_LOAD.
 *
 * The Factoring (OTR) section lists what OTR needs before it will buy the invoice, for a customer we factor only: the booking fields
 * (factorGapsForLoad, the same list the push and the release refuse on) and the two documents assembleOtrInvoice requires.
 */
import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton, TmsCard, TmsInput, TmsSelect } from '@/features/tms/kit'
import { DirectoryPicker } from '@/components/directory-picker/DirectoryPicker'
import { OwnFleetDriverPicker } from '@/components/OwnFleetDriverPicker'
import { useOwnFleetRoster } from '@/hooks/useOwnFleetRoster'
import { assignAsset, getShipmentBundle, listCustomers, setShipmentCustomer, patchCustomer, updateOrderDetails, updateStop } from '@/lib/apiClient'
import { customerRefOf } from '@/lib/customerRef'
import { isFactorBilled } from '@/lib/factorBilling'
import { stopPlace, stopsList } from '@/lib/stopPlace'
import { FIX_ANCHOR, STATE, ZIP, liveLoad, otrChecks, scrollToFix, text } from './reviewFix'
import { formatDateTimeInput, fromDateTimeInput } from '@/lib/date'
import type { CustomerRecord, OrderReference, ShipmentBundle } from '@/types/tms'
import type { Stop } from '@/types'
import { DEFAULT_REVIEW_REQUIREMENTS } from '@/lib/reviewRequirements'
import { apEmailList, apEmailTokens } from '@/lib/apEmails'
import { EmailChipsInput } from '@/features/directory/components/EmailChipsInput'

/** The version stamp of one load in a freshly read bundle. */
function freshLoadUpdatedAt(b: ShipmentBundle, loadId: string): string | undefined {
  return b.loads.find((l) => l.id === loadId)?.updatedAt ?? undefined
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? <CheckCircle2 size={14} aria-label="OK" className="lr-icon-ok" /> : <XCircle size={14} aria-label="Missing" className="lr-icon-bad" />
}

/** A bundle with every list present, so a partial answer never breaks the rail. */
function whole(b: Partial<ShipmentBundle> | null | undefined): ShipmentBundle | null {
  if (!b || !b.shipment) return null
  return { ...b, orders: b.orders ?? [], loads: b.loads ?? [], loadCarriers: b.loadCarriers ?? [], charges: b.charges ?? [], financials: b.financials ?? [], documents: b.documents ?? [] } as ShipmentBundle
}

export function ReviewFixPanel({ shipmentId, readOnly, busy, onSaved, failing }: {
  shipmentId: string
  readOnly: boolean
  busy: boolean
  /** Called after every successful save: the drawer re-runs the review. */
  onSaved: () => Promise<void> | void
  /** Codes of the reasons that fail now, so the matching editors open flagged. */
  failing: ReadonlySet<string>
}) {
  const [bundle, setBundle] = useState<ShipmentBundle | null>(null)
  const [customers, setCustomers] = useState<CustomerRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.resolve().then(() => getShipmentBundle(shipmentId)).then((b) => { if (live) setBundle(whole(b)) }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    Promise.resolve().then(() => listCustomers()).then((c) => { if (live) setCustomers(Array.isArray(c) ? c : []) }).catch(() => { if (live) setCustomers([]) })
    return () => { live = false }
  }, [shipmentId])

  const customerId = bundle?.orders[0]?.customerId ?? bundle?.shipment.customerId ?? null
  const customer = useMemo(() => customers?.find((c) => c.id === customerId) ?? null, [customers, customerId])

  // The board and the shipment notifier touch a shipment's version often; a rail save reads it fresh just before writing,
  // so a stamp from when the rail opened is never a false "changed by someone else".
  async function freshBundle(): Promise<ShipmentBundle> {
    const next = whole(await getShipmentBundle(shipmentId))
    if (!next) throw new Error('The shipment could not be read. Reload and try again.')
    return next
  }
  async function save(label: string, action: () => Promise<unknown>, success: string) {
    setSaving(label)
    setError(null)
    try {
      const next = await action()
      if (next && typeof next === 'object' && 'shipment' in next && 'loads' in next) setBundle(whole(next as ShipmentBundle))
      else setBundle(whole(await getShipmentBundle(shipmentId)))
      toast.success(success)
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSaving(null) }
  }

  if (error && !bundle) return <p role="alert" className="lr-fix-error">{error}</p>
  if (!bundle) return <p role="status" className="tms-muted text-sm">Loading the load's fields…</p>
  const off = readOnly || busy || saving !== null
  const order = bundle.orders[0]
  const otr = otrChecks(bundle, customer)
  return <div className="lr-fix" data-testid="review-fix-panel">
    {error && <p role="alert" className="lr-fix-error">{error}</p>}
    <CustomerFix customer={customer} customers={customers ?? []} linked={Boolean(customerId)} off={off} flagged={failing.has('NO_CUSTOMER') || failing.has('FACTOR_CUSTOMER_MC') || failing.has('FACTOR_BILLING_METHOD')}
      onLink={(id) => void save('customer', () => setShipmentCustomer({ shipmentId, customerId: id }), 'Customer linked')}
      onSave={(patch) => customer && void save('customer', async () => {
        // A patch: only the fields edited here change; everything else on the customer keeps what is stored.
        const updated = await patchCustomer(customer.id, { ...patch, changeReason: 'Load Review', changeSource: 'LOAD_REVIEW' }, customer.updatedAt ?? '')
        setCustomers((list) => (list ?? []).map((c) => c.id === updated.id ? updated : c))
      }, `${customer.name} saved`)} />
    <RefFix bundle={bundle} off={off} flagged={[...failing].some((c) => c === 'FACTOR_PO_MISSING' || c.startsWith('REFERENCE'))}
      onSave={(references) => order && void save('ref', async () => updateOrderDetails({ shipmentId, expectedUpdatedAt: (await freshBundle()).shipment.updatedAt ?? '', order: { references } }), 'Customer ref saved')} />
    <StopsFix bundle={bundle} off={off} onSave={(label, loadId, _updatedAt, op) => void save(label, async () => updateStop({ loadId, expectedUpdatedAt: freshLoadUpdatedAt(await freshBundle(), loadId), ...op }), 'Stop saved')} />
    <DriverFix bundle={bundle} off={off} flagged={failing.has('DRIVER_MISSING') || failing.has('CARRIER_NOT_ASSIGNED')}
      onAssign={(loadId, driverId, updatedAt) => void save('driver', () => assignAsset({ loadId, driverId, expectedUpdatedAt: updatedAt ?? undefined }), 'Driver assigned')} />
    {otr.length > 0 && <TmsCard className={`lr-check ${otr.every((c) => c.ok) ? 'lr-check-ok' : 'lr-check-bad'}`} title={<span id={FIX_ANCHOR.otr} className="lr-check-title"><Mark ok={otr.every((c) => c.ok)} />Factoring (OTR)</span>}>
      <p className="tms-muted text-xs">{customer?.name} is factored. OTR buys the invoice only with every item below; the invoice number, date and amount come from the invoice itself.</p>
      <ul className="lr-otr-list" data-testid="otr-checklist">{otr.map((c) => <li key={c.key} className={c.ok ? 'lr-chip-ok' : 'lr-chip-bad'}>
        <Mark ok={c.ok} /><span>{c.label}</span>{!c.ok && <TmsButton size="sm" variant="ghost" onClick={() => scrollToFix(c.anchor)}>Fix</TmsButton>}
      </li>)}</ul>
    </TmsCard>}
  </div>
}

type CustomerPatchFields = Pick<CustomerRecord, 'billingMethod' | 'customerType' | 'mcNumber' | 'apEmail' | 'apEmailsExtra' | 'paymentTermsDays' | 'reviewRequirements'>

function CustomerFix({ customer, customers, linked, off, flagged, onLink, onSave }: {
  customer: CustomerRecord | null
  customers: CustomerRecord[]
  linked: boolean
  off: boolean
  flagged: boolean
  onLink: (customerId: string) => void
  onSave: (patch: Partial<CustomerPatchFields>) => void
}) {
  const [pick, setPick] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CustomerPatchFields>>({})
  const value = <K extends keyof CustomerPatchFields>(key: K): CustomerPatchFields[K] | undefined => (key in draft ? draft[key] : customer?.[key]) as CustomerPatchFields[K] | undefined
  const factored = isFactorBilled({ ...customer, ...draft } as CustomerRecord)
  const reqs = value('reviewRequirements') ?? null
  const docOn = (key: 'podReceived' | 'rateConReceived' | 'apEmail') => factored || reqs == null || reqs.includes(key)
  const toggleDoc = (key: 'podReceived' | 'rateConReceived' | 'apEmail', on: boolean) => {
    const base = reqs ?? [...DEFAULT_REVIEW_REQUIREMENTS]
    setDraft((d) => ({ ...d, reviewRequirements: on ? [...new Set([...base, key])] : base.filter((k) => k !== key) }))
  }
  const dirty = Object.keys(draft).length > 0
  return <TmsCard className={`lr-check ${flagged ? 'lr-check-bad' : 'lr-check-ok'}`} title={<span id={FIX_ANCHOR.customer} className="lr-check-title"><Mark ok={!flagged} />Customer</span>}>
    {!linked && <div className="lr-fix-row lr-fix-flag">
      <span className="lr-fix-label">Link a customer</span>
      <DirectoryPicker type="customer" value={pick} customers={customers} locations={[]} placeholder="Search customers…" onChange={(id) => setPick(id)} />
      <TmsButton size="sm" variant="primary" disabled={off || !pick} onClick={() => pick && onLink(pick)}>Link</TmsButton>
    </div>}
    {customer && <>
      <p className="tms-muted text-xs">These change {customer.name} for all of its loads.</p>
      <div className="lr-fix-grid">
        <label className={`lr-fix-field ${!value('billingMethod') && customer.factored !== true ? 'lr-fix-flag' : ''}`}>Billing method
          <TmsSelect aria-label="Billing method" value={value('billingMethod') ?? (customer.factored ? 'FACTOR' : '')} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, billingMethod: (e.target.value || null) as CustomerRecord['billingMethod'] }))}>
            <option value="">Not set</option><option value="FACTOR">Factor (OTR)</option><option value="MANUAL">Manual invoice</option>
          </TmsSelect></label>
        <label className="lr-fix-field">Customer type
          <TmsSelect aria-label="Customer type" value={value('customerType') ?? ''} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, customerType: (e.target.value || null) as CustomerRecord['customerType'] }))}>
            <option value="">Not set</option><option value="BROKER">Broker</option><option value="SHIPPER">Shipper</option>
          </TmsSelect></label>
        <label className={`lr-fix-field ${factored && value('customerType') !== 'SHIPPER' && !text(value('mcNumber')) ? 'lr-fix-flag' : ''}`}>MC #
          <TmsInput aria-label="MC number" value={value('mcNumber') ?? ''} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, mcNumber: e.target.value }))} /></label>
        <div className={`lr-fix-field ${docOn('apEmail') && apEmailList({ apEmail: value('apEmail'), apEmailsExtra: value('apEmailsExtra') }).length === 0 ? 'lr-fix-flag' : ''}`}>AP / invoice e-mails{!docOn('apEmail') && <span className="tms-muted text-xs"> (not required)</span>}
          <EmailChipsInput
            label="AP e-mail"
            disabled={off}
            value={apEmailTokens({ apEmail: value('apEmail'), apEmailsExtra: value('apEmailsExtra') })}
            onChange={(list) => setDraft((d) => ({ ...d, apEmail: list[0] ?? null, apEmailsExtra: list.length > 1 ? list.slice(1) : null }))}
          /></div>
        <label className={`lr-fix-field ${!value('paymentTermsDays') ? 'lr-fix-flag' : ''}`}>Payment terms (days)
          <TmsInput aria-label="Payment terms days" type="number" min={0} value={value('paymentTermsDays') ?? ''} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, paymentTermsDays: e.target.value === '' ? null : Number(e.target.value) }))} /></label>
        <fieldset className="lr-fix-field"><legend>Required to invoice</legend>
          <label><input type="checkbox" checked={docOn('podReceived')} disabled={off || factored} onChange={(e) => toggleDoc('podReceived', e.target.checked)} /> POD</label>
          <label><input type="checkbox" checked={docOn('rateConReceived')} disabled={off || factored} onChange={(e) => toggleDoc('rateConReceived', e.target.checked)} /> RC</label>
          <label><input type="checkbox" checked={docOn('apEmail')} disabled={off || factored} onChange={(e) => toggleDoc('apEmail', e.target.checked)} /> AP e-mail</label>
          {factored && <span className="tms-muted text-xs">Factored: OTR needs all three.</span>}
        </fieldset>
      </div>
      <div className="lr-fix-actions">
        <TmsButton size="sm" variant="primary" disabled={off || !dirty} onClick={() => { onSave(draft); setDraft({}) }}>Save customer</TmsButton>
        {dirty && <TmsButton size="sm" variant="ghost" disabled={off} onClick={() => setDraft({})}>Undo</TmsButton>}
      </div>
    </>}
  </TmsCard>
}

function RefFix({ bundle, off, flagged, onSave }: { bundle: ShipmentBundle; off: boolean; flagged: boolean; onSave: (references: OrderReference[]) => void }) {
  const order = bundle.orders[0]
  const load = bundle.loads.find(liveLoad) ?? bundle.loads[0]
  const refs = (order?.references ?? []) as OrderReference[]
  const current = customerRefOf(refs, load?.tmsId ?? null) ?? ''
  const [value, setValue] = useState(current)
  const po = refs.find((r) => text(r.code).toUpperCase() === 'PO')
  const changed = text(value) !== text(po?.value ?? '') && text(value).length > 0
  function next(): OrderReference[] {
    const v = text(value)
    if (po) return refs.map((r) => r === po ? { ...r, value: v, visibility: r.visibility === 'INTERNAL' || r.visibility === 'CARRIER' ? 'CUSTOMER' : r.visibility } : r)
    return [...refs, { code: 'PO', label: 'PO', value: v, level: 'ORDER', visibility: 'CUSTOMER' }]
  }
  return <TmsCard className={`lr-check ${flagged ? 'lr-check-bad' : 'lr-check-ok'}`} title={<span id={FIX_ANCHOR.ref} className="lr-check-title"><Mark ok={!flagged} />Customer ref (PO)</span>}>
    <div className={`lr-fix-row ${flagged ? 'lr-fix-flag' : ''}`}>
      <TmsInput aria-label="Customer ref (PO)" placeholder="PO / customer reference" value={value} disabled={off} onChange={(e) => setValue(e.target.value)} />
      <TmsButton size="sm" variant="primary" disabled={off || !changed} onClick={() => onSave(next())}>Save PO</TmsButton>
    </div>
    {refs.filter((r) => text(r.code).toUpperCase() !== 'PO' && text(r.value)).length > 0 && <p className="tms-muted text-xs">Other references: {refs.filter((r) => text(r.code).toUpperCase() !== 'PO' && text(r.value)).map((r) => `${r.label || r.code} ${r.value}`).join(' · ')}</p>}
  </TmsCard>
}

type StopOpInput = { op: 'SET_APPT' | 'SET_TIMES' | 'SET_LOCATION'; stopId: string; patch: Record<string, unknown> }

function StopsFix({ bundle, off, onSave }: { bundle: ShipmentBundle; off: boolean; onSave: (label: string, loadId: string, updatedAt: string | null | undefined, op: StopOpInput) => void }) {
  const loads = bundle.loads.filter(liveLoad)
  const all = loads.flatMap((l) => stopsList<Stop>(l.stops).map((s) => ({ load: l, stop: s })))
  const lastDelivery = [...all].reverse().find((x) => x.stop.type === 'delivery')?.stop.id
  const bad = all.some(({ stop }) => { const p = stopPlace(stop as never); return !p.city || !STATE.test(p.state ?? '') || !ZIP.test(p.zip ?? '') || !text(stop.appt) })
  return <TmsCard className={`lr-check ${bad ? 'lr-check-bad' : 'lr-check-ok'}`} title={<span id={FIX_ANCHOR.stops} className="lr-check-title"><Mark ok={!bad} />Stops</span>}>
    {all.map(({ load, stop }, index) => <StopFix key={stop.id} n={index + 1} stop={stop} final={stop.id === lastDelivery} off={off}
      onSave={(op) => onSave(`stop-${stop.id}`, load.id, load.updatedAt, { ...op, stopId: stop.id })} />)}
  </TmsCard>
}

function StopFix({ n, stop, final, off, onSave }: { n: number; stop: Stop; final: boolean; off: boolean; onSave: (op: Omit<StopOpInput, 'stopId'>) => void }) {
  const place = stopPlace(stop as never)
  const [city, setCity] = useState(place.city ?? '')
  const [state, setState] = useState(place.state ?? '')
  const [zip, setZip] = useState(place.zip ?? '')
  const [appt, setAppt] = useState(stop.appt ? formatDateTimeInput(stop.appt) : '')
  const [apptType, setApptType] = useState(stop.apptType ?? 'exact')
  const [arrived, setArrived] = useState(stop.arrivedAt ? formatDateTimeInput(stop.arrivedAt) : '')
  const [departed, setDeparted] = useState(stop.departedAt ? formatDateTimeInput(stop.departedAt) : '')
  const placeDirty = city !== (place.city ?? '') || state !== (place.state ?? '') || zip !== (place.zip ?? '')
  const apptDirty = appt !== (stop.appt ? formatDateTimeInput(stop.appt) : '') || apptType !== (stop.apptType ?? 'exact')
  const timesDirty = arrived !== (stop.arrivedAt ? formatDateTimeInput(stop.arrivedAt) : '') || departed !== (stop.departedAt ? formatDateTimeInput(stop.departedAt) : '')
  const flag = (bad: boolean) => (bad ? 'lr-fix-flag' : '')
  const title = `Stop ${n} · ${stop.type === 'pickup' ? 'Pick up' : 'Delivery'}${stop.name ? ` · ${stop.name}` : ''}`
  return <div className="lr-stop" data-testid={`lr-stop-${n}`}>
    <p className="lr-stop-title">{title}</p>
    <div className="lr-fix-grid">
      <label className={`lr-fix-field ${flag(!text(city))}`}>City<TmsInput aria-label={`Stop ${n} city`} value={city} disabled={off} onChange={(e) => setCity(e.target.value)} /></label>
      <label className={`lr-fix-field ${flag(!STATE.test(text(state)))}`}>State<TmsInput aria-label={`Stop ${n} state`} maxLength={2} value={state} disabled={off} onChange={(e) => setState(e.target.value.toUpperCase())} /></label>
      <label className={`lr-fix-field ${flag(!ZIP.test(text(zip)))}`}>ZIP<TmsInput aria-label={`Stop ${n} ZIP`} inputMode="numeric" value={zip} disabled={off} onChange={(e) => setZip(e.target.value)} /></label>
    </div>
    {placeDirty && <TmsButton size="sm" variant="primary" disabled={off || !text(city)} onClick={() => onSave({ op: 'SET_LOCATION', patch: {
      locationId: stop.locationId ?? null, name: stop.name ?? null, city: [text(city), text(state)].filter(Boolean).join(', '),
      address: { ...(stop.address ?? {}), city: text(city), state: text(state).toUpperCase() || null, zip: text(zip) || null },
    } })}>Save location</TmsButton>}
    <div className="lr-fix-grid">
      <label className={`lr-fix-field ${flag(!appt)}`}>Appointment<TmsInput type="datetime-local" aria-label={`Stop ${n} appointment`} value={appt} disabled={off} onChange={(e) => setAppt(e.target.value)} /></label>
      <label className="lr-fix-field">Type<TmsSelect aria-label={`Stop ${n} appointment type`} value={apptType} disabled={off} onChange={(e) => setApptType(e.target.value as Stop['apptType'] & string)}>
        <option value="exact">Exact</option><option value="range">Window</option><option value="fcfs">FCFS</option><option value="tbd">TBD</option>
      </TmsSelect></label>
    </div>
    {apptDirty && <TmsButton size="sm" variant="primary" disabled={off || !appt} onClick={() => onSave({ op: 'SET_APPT', patch: { appt: fromDateTimeInput(appt), apptType } })}>Save appointment</TmsButton>}
    <div className="lr-fix-grid">
      <label className="lr-fix-field">Arrived<TmsInput type="datetime-local" aria-label={`Stop ${n} arrived`} value={arrived} disabled={off} onChange={(e) => setArrived(e.target.value)} /></label>
      <label className={`lr-fix-field ${flag(final && !departed)}`}>{final ? 'Delivered' : 'Departed'}<TmsInput type="datetime-local" aria-label={`Stop ${n} ${final ? 'delivered' : 'departed'}`} value={departed} disabled={off} onChange={(e) => setDeparted(e.target.value)} /></label>
    </div>
    {timesDirty && <TmsButton size="sm" variant="primary" disabled={off} onClick={() => onSave({ op: 'SET_TIMES', patch: { arrivedAt: arrived ? fromDateTimeInput(arrived) : null, departedAt: departed ? fromDateTimeInput(departed) : null } })}>Save times</TmsButton>}
  </div>
}

function DriverFix({ bundle, off, flagged, onAssign }: { bundle: ShipmentBundle; off: boolean; flagged: boolean; onAssign: (loadId: string, driverId: string, updatedAt: string | null | undefined) => void }) {
  const roster = useOwnFleetRoster()
  const [pick, setPick] = useState('')
  const load = bundle.loads.find(liveLoad) ?? bundle.loads[0]
  const legs = bundle.loadCarriers.filter((lc) => lc.status === 'ACTIVE')
  const own = legs.find((lc) => lc.kind === 'OWN_ASSET')
  if (!flagged) return null
  return <TmsCard className="lr-check lr-check-bad" title={<span id={FIX_ANCHOR.driver} className="lr-check-title"><Mark ok={false} />Carrier / driver</span>}>
    {(own || legs.length === 0) && load ? <div className="lr-fix-row lr-fix-flag">
      <span className="lr-fix-label">Ivan Cartage driver</span>
      <OwnFleetDriverPicker roster={roster} value={pick || own?.driverId || ''} disabled={off} ariaLabel="Driver" onChange={(d) => setPick(d?.id ?? '')} />
      <TmsButton size="sm" variant="primary" disabled={off || !pick} onClick={() => onAssign(load.id, pick, load.updatedAt)}>Assign driver</TmsButton>
    </div> : null}
    {!own && <p className="tms-muted text-xs">An outside carrier is booked on the shipment&apos;s Carrier tab (rate con, carrier pay and tracking come with it).</p>}
  </TmsCard>
}
