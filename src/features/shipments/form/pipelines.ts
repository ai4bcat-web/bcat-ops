/**
 * Create and edit pipelines (AH-plan §8): ordered calls to existing apiClient wrappers, each
 * run against the latest bundle (every response replaces the CAS token), skipped when its
 * diff is empty, recorded in `steps`. `CREATE_SHIPMENT` burns a permanent number, so it is
 * never called twice: after it succeeds a failure returns `createdShipmentId` and a retry
 * passes `resume` to re-run only what did not finish.
 */
import {
  addCarrier, assignAsset, assignCarrierRep, clearRevTag, commitDocument, createLocation, createShipment,
  prepareDocumentUpload, putPresignedFile, recalcCharges, saveOrderForm, setEta, setRevTag, setSalesRep, setShipmentCustomer,
  getShipmentBundle, setStopDrivers, submitOrder, updateLoadCarrierDetails, updateOrderDetails, updateStop, updateStopDetails,
  type UpdateLoadCarrierDetailsInput,
} from '@/lib/apiClient'
import { apptNotices } from '@/lib/apptNotify'
import { fromDateTimeInput } from '@/lib/date'
import { isIvanCartageName, ownFleetDriverByName, type OwnFleetDriverOption } from '@/lib/ownFleetDrivers'
import { errorMessage } from '@/lib/utils/errorMessage'
import type { Stop } from '@/types'
import type { CustomerRecord, LoadCarrierRecord, LocationRecord, ShipmentBundle, TmsSettings } from '@/types/tms'
import { applyNewShipmentEffects, linkStopsToDirectory } from '../newShipmentEffects'
import {
  chargesForBundle, firstPickupIndex, lastDeliveryIndex, rebaseCharges, toAddCarrierInput, toCreateInput, toSaveOrderFormInput, toStop, toStops,
  toUpdateOrderDetailsInput,
} from './mapping'
import {
  activeLoadCarrier, carrierSlotsOf, isCustomerDefaultDivision, liveCarriers, lockedFields, valuesFromBundle, type CarrierSlot, type ShipmentFormValues,
} from './model'
import { blockingIssues, issueSummary, validateForm, type ValidationLevel } from './validation'

export interface PipelineCtx {
  ownFleetRoster?: readonly OwnFleetDriverOption[]
  customer: CustomerRecord | null
  locations: LocationRecord[]
  /** Resolves the full directory (loaded on first need); linking stops to it must see every location, never a partial list. */
  loadLocations?: () => Promise<LocationRecord[]>
  settings: TmsSettings | null
  actorName: string
  isBatory: boolean
  refreshDirectory?: () => void
  onNotice?: (message: string) => void
}

export interface PipelineStep { step: string; ok: boolean; message?: string }

export interface PipelineResult {
  ok: boolean
  /** The latest bundle the pipeline saw (null only when nothing was ever created). */
  bundle: ShipmentBundle | null
  steps: PipelineStep[]
  /** Set as soon as CREATE_SHIPMENT succeeds, even if a later step fails. */
  createdShipmentId?: string
  /** The failing step and every step that did not run after it. */
  failedSteps: string[]
  /** The server's text, verbatim, for the failing step (or the client validation summary). */
  message?: string
}

export interface ResumePoint { shipmentId: string; done: string[] }

class Runner {
  steps: PipelineStep[] = []
  failed: string[] = []
  message?: string
  bundle: ShipmentBundle | null
  private done: Set<string>
  private planned: string[]
  constructor(bundle: ShipmentBundle | null, done: Set<string>, planned: string[]) {
    this.bundle = bundle
    this.done = done
    this.planned = planned
  }

  get stopped(): boolean { return this.failed.length > 0 }

  /** Run one step unless an earlier one failed or a resume says it is already done. */
  async run(name: string, fn: () => Promise<ShipmentBundle | void>): Promise<void> {
    if (this.stopped || this.done.has(name)) return
    try {
      const next = await fn()
      if (next) this.bundle = next
      this.steps.push({ step: name, ok: true })
    } catch (err) {
      const message = errorMessage(err)
      this.steps.push({ step: name, ok: false, message })
      this.message = message
      this.failed.push(name)
    }
  }

  result(extra: Partial<PipelineResult> = {}): PipelineResult {
    if (this.stopped) {
      const ran = new Set(this.steps.map((s) => s.step))
      for (const p of this.planned) if (!ran.has(p) && !this.done.has(p) && !this.failed.includes(p)) this.failed.push(p)
    }
    return { ok: !this.stopped, bundle: this.bundle, steps: this.steps, failedSteps: this.failed, message: this.message, ...extra }
  }
}

const fail = (message: string, bundle: ShipmentBundle | null = null): PipelineResult =>
  ({ ok: false, bundle, steps: [], failedSteps: [], message })

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function precheck(values: ShipmentFormValues, ctx: PipelineCtx, level: ValidationLevel, mode: 'create' | 'edit'): string | null {
  const blocking = blockingIssues(validateForm(values, { level, mode, customer: ctx.customer, settings: ctx.settings }))
  return blocking.length > 0 ? issueSummary(blocking) : null
}

async function applyRoles(r: Runner, values: ShipmentFormValues, skipTag = false): Promise<void> {
  await r.run('revTag', async () => {
    if (skipTag) return
    const s = r.bundle!.shipment
    const div = values.ship.revDivision
    const sub = values.ship.revSubdivision
    if (div === (s.revDivision ?? '') && sub === (s.revSubdivision ?? '')) return
    if (!div) return s.revDivision ? clearRevTag({ shipmentId: s.id }) : undefined
    return setRevTag({ shipmentId: s.id, divisionCode: div, ...(sub ? { subdivisionCode: sub } : {}) })
  })
  await r.run('salesRep', async () => {
    const s = r.bundle!.shipment
    const want = values.roles.salesRepId
    if (want === (s.salesRepId ?? '')) return
    return setSalesRep({ shipmentId: s.id, repId: want || null })
  })
  await r.run('dispatcher', async () => {
    const s = r.bundle!.shipment
    const want = values.roles.dispatcherAssignedId
    const active = activeLoadCarrier(r.bundle)
    const has = active?.carrierRepId ?? s.carrierRepId ?? ''
    if (!want || want === has) return
    return assignCarrierRep({ shipmentId: s.id, repId: want, expectedUpdatedAt: s.updatedAt })
  })
}

/** The first stop writes the form's linked locations back onto the form so SAVE keeps the links. */
async function linkedValues(values: ShipmentFormValues, ctx: PipelineCtx): Promise<ShipmentFormValues> {
  try {
    const linked = await linkStopsToDirectory(toStops(values), ctx.loadLocations ? await ctx.loadLocations() : ctx.locations, {
      createLocation, refresh: ctx.refreshDirectory, notify: ctx.onNotice,
    })
    return {
      ...values,
      stops: values.stops.map((s, i) => ({
        ...s,
        locationId: linked[i]?.locationId ?? s.locationId,
      })),
    }
  } catch (err) {
    console.warn('[shipment form] could not link stops to the directory', err)
    return values
  }
}

async function saveDraftBody(r: Runner, values: ShipmentFormValues, ctx: PipelineCtx, draftSave: boolean, skipTag = false): Promise<void> {
  // A shipment built with only a typed customer name has no customer record. Picking one in the form must LINK it
  // (SET_SHIPMENT_CUSTOMER also fills the blank bill-to and sales rep from the customer). Without this the pick was
  // never written, the next reload dropped it, and Submit kept saying Bill to / Sales rep were missing.
  const chosen = values.customer.useTyped ? '' : values.customer.id
  if (chosen && !(r.bundle!.orders[0]?.customerId || r.bundle!.shipment.customerId)) {
    await r.run('customer', () => setShipmentCustomer({ shipmentId: r.bundle!.shipment.id, customerId: chosen }))
  }
  await r.run('save', () => saveOrderForm(toSaveOrderFormInput(values, r.bundle!, { draftSave, ladder: ctx.isBatory })))
  await applyRoles(r, values, skipTag)
}

const CREATE_STEPS = ['create', 'save', 'revTag', 'salesRep', 'dispatcher', 'effects', 'documents', 'assignDriver']

/** Create shipment (strict) / Save draft (lenient) in create mode. */
export async function runCreate(
  values: ShipmentFormValues, ctx: PipelineCtx, o: { draftSave: boolean; resume?: ResumePoint },
): Promise<PipelineResult> {
  const problem = precheck(values, ctx, o.draftSave ? 'draft' : 'create', 'create')
  if (problem) return fail(problem)
  const done = new Set(o.resume?.done ?? [])
  const r = new Runner(null, done, CREATE_STEPS.filter((step) => step !== 'documents'))
  let working = values
  let createdId = o.resume?.shipmentId
  if (createdId) {
    try { r.bundle = await getShipmentBundle(createdId) } catch (err) { return fail(errorMessage(err)) }
  } else {
    working = await linkedValues(values, ctx)
    await r.run('create', () => createShipment(toCreateInput(working, { ladder: ctx.isBatory })))
    createdId = r.bundle?.shipment.id
    if (!createdId) return r.result()
  }
  if (!done.has('save') && r.bundle) working = rebaseCharges(working, r.bundle)
  // A driver to assign: the division is the server's to derive (a HAND tag would win over the rules), unless the user chose it.
  const assigning = working.carrier.isOwnFleet && working.carrier.driver1.name.trim() !== ''
  await saveDraftBody(r, working, ctx, o.draftSave, assigning && isCustomerDefaultDivision(working, ctx.customer))
  await r.run('effects', async () => {
    const load = r.bundle?.loads[0]
    if (!r.bundle || !load) return
    const stops: Stop[] = load.stops ?? toStops(working)
    try {
      await applyNewShipmentEffects({
        bundle: r.bundle, stops, prevNotices: apptNotices(stops, []), isBatory: ctx.isBatory, actorName: ctx.actorName,
      })
    } catch (err) {
      console.warn('[shipment form] post-create effects failed', err)
    }
  })
  if (!r.stopped && working.docs.queued.length > 0 && r.bundle) {
    const steps = await runUploadQueued(working, r.bundle)
    const bad = steps.find((s) => !s.ok)
    r.steps.push(...steps)
    if (bad) { r.failed.push('documents'); r.message = bad.message }
  }
  if (assigning) {
    await r.run('assignDriver', async () => {
      const driver = ownFleetDriverByName(ctx.ownFleetRoster ?? [], working.carrier.driver1.name)
      if (!driver) throw new Error('The selected driver is no longer available. Pick a driver using Cover.')
      const load = r.bundle!.loads[0]
      if (!load) throw new Error('The shipment has no load to assign.')
      return assignAsset({
        loadId: load.id,
        driverId: driver.id,
        truckId: driver.truckId ?? undefined,
        truckNumber: driver.truckNumber || undefined,
        trailerId: driver.trailerId ?? undefined,
        trailerNumber: driver.trailerNumber || undefined,
      })
    })
    if (r.failed.includes('assignDriver')) r.message = `Shipment created, driver assignment failed: ${r.message}. Retry using Cover.`
    else await applyDeliveryDriver(r, working, ctx)
  }
  return r.result({ createdShipmentId: createdId })
}

/**
 * Own fleet: who drives the pickup and who drives the delivery. Driver 1 is on the whole load by default (ASSIGN_ASSET); a delivery
 * driver picked on the form moves just the delivery stops to that person (SET_STOP_DRIVERS), and clearing it puts the delivery
 * back on Driver 1. It compares with what the stops hold now, so a save that changes nothing makes no call.
 */
async function applyDeliveryDriver(r: Runner, values: ShipmentFormValues, ctx: PipelineCtx): Promise<void> {
  const c = values.carrier
  if (!c.isOwnFleet || !c.driver1.name.trim()) return
  const roster = ctx.ownFleetRoster ?? []
  const pickup = ownFleetDriverByName(roster, c.driver1.name)
  if (!pickup) return
  const wanted = c.deliveryDriverId && c.deliveryDriverId !== pickup.id ? c.deliveryDriverId : pickup.id
  await r.run('deliveryDriver', async () => {
    const load = r.bundle?.loads[0]
    if (!load) return
    if (wanted !== pickup.id && !roster.some((d) => d.id === wanted)) throw new Error('The selected delivery driver is no longer available. Pick another driver.')
    const deliveries = ((load.stops ?? []) as Stop[]).filter((s) => s.type === 'delivery')
    const assignments = deliveries.filter((s) => (s.driverId ?? null) !== wanted).map((s) => ({ stopId: s.id, driverId: wanted }))
    if (assignments.length === 0) return
    await setStopDrivers({ loadId: load.id, assignments })
    return getShipmentBundle(r.bundle!.shipment.id)
  })
  if (r.failed.includes('deliveryDriver')) r.message = `Saved, but the delivery driver was not set: ${r.message}`
}

/** Upload files picked before the first save: PREPARE → S3 PUT → COMMIT, one result per file. */
export async function runUploadQueued(values: ShipmentFormValues, bundle: ShipmentBundle): Promise<PipelineStep[]> {
  const out: PipelineStep[] = []
  for (const [i, q] of values.docs.queued.entries()) {
    const step = `document:${i}`
    try {
      const prepared = await prepareDocumentUpload({
        shipmentId: bundle.shipment.id, type: q.type, name: q.file.name, contentType: q.file.type, sizeBytes: q.file.size,
      })
      await putPresignedFile(prepared.uploadUrl, q.file, q.file.type)
      await commitDocument({
        shipmentId: bundle.shipment.id, documentId: prepared.documentId, s3Key: prepared.s3Key, type: q.type,
        name: q.file.name, contentType: q.file.type, sizeBytes: q.file.size, audience: q.audience,
      })
      out.push({ step, ok: true })
    } catch (err) {
      out.push({ step, ok: false, message: errorMessage(err) })
    }
  }
  return out
}

/** Save draft: create when nothing exists yet, else a lenient SAVE_ORDER_FORM (or the non-draft edit path). */
/**
 * An Ivan Cartage (own fleet) driver picked on an EXISTING shipment. The typed carrier patch never carries an own-fleet driver, and
 * assignment used to run only when the shipment was created, so a pick on an open shipment was dropped on save and the picker
 * snapped back to "Pick a driver". Assign when the picked driver differs from the one the saved shipment shows.
 */
async function assignPickedDriver(r: Runner, values: ShipmentFormValues, ctx: PipelineCtx, saved: ShipmentBundle): Promise<void> {
  const wanted = values.carrier.driver1.name.trim()
  if (!values.carrier.isOwnFleet || !wanted) return
  const was = valuesFromBundle(saved, { customer: ctx.customer }).carrier.driver1.name.trim()
  if (was.toLowerCase() !== wanted.toLowerCase()) {
    await r.run('assignDriver', async () => {
      const driver = ownFleetDriverByName(ctx.ownFleetRoster ?? [], wanted)
      if (!driver) throw new Error('The selected driver is no longer available. Pick a driver using Cover.')
      const load = r.bundle?.loads[0]
      if (!load) return
      return assignAsset({
        loadId: load.id,
        driverId: driver.id,
        truckId: driver.truckId ?? undefined,
        truckNumber: driver.truckNumber || undefined,
        trailerId: driver.trailerId ?? undefined,
        trailerNumber: driver.trailerNumber || undefined,
      })
    })
    if (r.failed.includes('assignDriver')) { r.message = `Saved, but the driver was not assigned: ${r.message}`; return }
  }
  // The delivery may have its own driver (or be put back on Driver 1): sort out the stops after Driver 1 is on the load.
  await applyDeliveryDriver(r, values, ctx)
}

export async function runSaveDraft(
  values: ShipmentFormValues, ctx: PipelineCtx, bundle: ShipmentBundle | null,
): Promise<PipelineResult> {
  if (!bundle) return runCreate(values, ctx, { draftSave: true })
  if (bundle.shipment.status !== 'DRAFT') return runEditSave(values, ctx, bundle)
  const problem = precheck(values, ctx, 'draft', 'edit')
  if (problem) return fail(problem, bundle)
  const r = new Runner(bundle, new Set(), ['save', 'revTag', 'salesRep', 'dispatcher', 'assignDriver', 'deliveryDriver'])
  await saveDraftBody(r, values, ctx, true)
  await assignPickedDriver(r, values, ctx, bundle)
  return r.result()
}

// ── edit of a non-DRAFT shipment ─────────────────────────────────────────────

export type StopWireOp =
  | { op: 'ADD'; stop: Stop }
  | { op: 'REMOVE'; stopId: string }
  | { op: 'SET_TYPE'; stopId: string; patch: Partial<Stop> }
  | { op: 'SET_LOCATION' | 'SET_APPT' | 'SET_REQUESTED' | 'SET_REFS'; stopId: string; patch: Partial<Stop> }
  | { op: 'SET_DETAILS'; stopId: string; patch: { instructions: string | null; pieces: number | null; weightLbs: number | null } }
  | { op: 'SWAP'; stopId: string; patch: { withStopId: string } }

function stopsWire(values: ShipmentFormValues): Stop[] {
  return values.stops.map((s, i, arr) => {
    const fp = firstPickupIndex(arr)
    const ld = lastDeliveryIndex(arr)
    return toStop(s, i, i === fp ? 'first-pickup' : i === ld ? 'last-delivery' : 'other')
  })
}

/** The UPDATE_STOP ops that turn `before` into `after`, diffed by stop id. Pure. */
export function diffStopOps(before: ShipmentFormValues, after: ShipmentFormValues): StopWireOp[] {
  const a = stopsWire(before)
  const b = stopsWire(after)
  const byId = new Map(a.map((s) => [s.id, s]))
  const keep = new Set(b.map((s) => s.id))
  const ops: StopWireOp[] = []
  for (const s of a) if (!keep.has(s.id) && !s.arrivedAt && !s.departedAt) ops.push({ op: 'REMOVE', stopId: s.id })
  for (const s of b) {
    const was = byId.get(s.id)
    if (!was) { ops.push({ op: 'ADD', stop: s }); continue }
    if (was.type !== s.type) ops.push({ op: 'SET_TYPE', stopId: s.id, patch: { type: s.type } })
    const pick = (x: Stop, keys: (keyof Stop)[]) => keys.map((k) => x[k] ?? null)
    if (!eq(pick(was, ['locationId', 'name', 'city', 'address', 'contact']), pick(s, ['locationId', 'name', 'city', 'address', 'contact']))) {
      ops.push({ op: 'SET_LOCATION', stopId: s.id, patch: { locationId: s.locationId ?? null, name: s.name, city: s.city, address: s.address ?? null, contact: s.contact ?? null } })
    }
    if (!eq(pick(was, ['appt', 'apptType', 'apptEnd']), pick(s, ['appt', 'apptType', 'apptEnd']))) {
      ops.push({ op: 'SET_APPT', stopId: s.id, patch: { appt: s.appt, apptType: s.apptType, apptEnd: s.apptEnd, apptNote: s.apptNote } })
    }
    if (!eq(pick(was, ['requestedStart', 'requestedEnd']), pick(s, ['requestedStart', 'requestedEnd']))) {
      ops.push({ op: 'SET_REQUESTED', stopId: s.id, patch: { requestedStart: s.requestedStart ?? null, requestedEnd: s.requestedEnd ?? null, apptRequestedBy: s.apptRequestedBy, apptNote: s.apptNote } })
    }
    if (!eq(was.refs ?? null, s.refs ?? null)) {
      ops.push({ op: 'SET_REFS', stopId: s.id, patch: { refs: s.refs ?? [], stopNotes: s.stopNotes, documentContact: s.documentContact } })
    }
    if (!eq(pick(was, ['instructions', 'pieces', 'weightLbs']), pick(s, ['instructions', 'pieces', 'weightLbs']))) {
      ops.push({ op: 'SET_DETAILS', stopId: s.id, patch: { instructions: s.instructions ?? null, pieces: s.pieces ?? null, weightLbs: s.weightLbs ?? null } })
    }
  }
  // Order: after removals and appends the server holds `current`; selection-sort it into `b`.
  const current = [...a.filter((s) => keep.has(s.id)).map((s) => s.id), ...b.filter((s) => !byId.has(s.id)).map((s) => s.id)]
  const want = b.map((s) => s.id)
  for (let i = 0; i < want.length; i++) {
    if (current[i] === want[i]) continue
    const j = current.indexOf(want[i])
    ops.push({ op: 'SWAP', stopId: current[i], patch: { withStopId: want[i] } })
    ;[current[i], current[j]] = [current[j], current[i]]
  }
  return ops
}

/** The assignment a slot shows: by its booked id; slot 0 falls back to the primary assignment. */
function loadCarrierOfSlot(bundle: ShipmentBundle, slot: CarrierSlot, index: number): LoadCarrierRecord | null {
  const live = liveCarriers(bundle)
  return live.find((lc) => lc.id === slot.loadCarrierId) ?? (index === 0 ? live[0] ?? null : null)
}

const sameLegs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id))

function carrierDetailsPatch(slot: CarrierSlot, lc: LoadCarrierRecord, withLegs: boolean): Omit<UpdateLoadCarrierDetailsInput, 'loadCarrierId' | 'expectedUpdatedAt'> | null {
  if (lc.kind !== 'CARRIER') return null
  const c = slot
  // Step AQ: an Ivan Cartage leg's driver, truck and trailer come from a Driver record through
  // ENTER_DRIVER_INFO's picker; this typed patch never carries them.
  const ivan = isIvanCartageName(lc.carrierName)
  const want = {
    dispatcherName: c.dispatcher.name, dispatcherPhone: c.dispatcher.phone, dispatcherEmail: c.dispatcher.email,
    ...(ivan ? {} : {
      driverName: c.driver1.name, driverPhone: c.driver1.phone, driver2Name: c.driver2.name, driver2Phone: c.driver2.phone,
      truckNumber: c.truckNo, trailerNumber: c.trailerNo,
    }),
    sealNumber: c.seal, tripNumber: c.carrierRef,
  } as Record<string, string>
  const patch: Record<string, string | string[] | null> = {}
  for (const [k, v] of Object.entries(want)) {
    if ((lc[k as keyof typeof lc] as string | null | undefined ?? '') !== v.trim()) patch[k] = v.trim() || null
  }
  if (withLegs && !sameLegs(lc.legStopIds ?? [], c.legStopIds)) patch.legStopIds = c.legStopIds
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Save changes. A DRAFT takes the strict SAVE_ORDER_FORM path; anything else composes
 * UPDATE_ORDER_DETAILS → UPDATE_STOP ops → RECALC_CHARGES → tags → carrier details, and
 * never calls SAVE_ORDER_FORM.
 */
export async function runEditSave(values: ShipmentFormValues, ctx: PipelineCtx, bundle: ShipmentBundle): Promise<PipelineResult> {
  const problem = precheck(values, ctx, 'create', 'edit')
  if (problem) return fail(problem, bundle)
  if (bundle.shipment.status === 'DRAFT') {
    const r = new Runner(bundle, new Set(), ['save', 'revTag', 'salesRep', 'dispatcher', 'assignDriver', 'deliveryDriver'])
    await saveDraftBody(r, values, ctx, false)
    await assignPickedDriver(r, values, ctx, bundle)
    return r.result()
  }
  const seed = { customer: ctx.customer }
  const before = valuesFromBundle(bundle, seed)
  const locks = lockedFields(bundle)
  const r = new Runner(bundle, new Set(), ['order', 'stops', 'charges', 'revTag', 'salesRep', 'dispatcher', 'carrier', 'assignDriver', 'deliveryDriver', 'eta'])

  await r.run('order', async () => {
    const next = toUpdateOrderDetailsInput(values, r.bundle!)
    const prev = toUpdateOrderDetailsInput(before, r.bundle!)
    if (eq({ ...next, expectedUpdatedAt: '' }, { ...prev, expectedUpdatedAt: '' })) return
    return updateOrderDetails(next)
  })
  const runStopOps = async (from: ShipmentFormValues) => {
    for (const op of diffStopOps(from, values)) {
      const b = r.bundle!
      const load = b.loads[0]
      if (!load) break
      const common = { loadId: load.id, expectedUpdatedAt: load.updatedAt ?? '' }
      if (op.op === 'ADD') r.bundle = await updateStop({ ...common, op: 'ADD', patch: op.stop })
      else if (op.op === 'REMOVE') r.bundle = await updateStop({ ...common, op: 'REMOVE', stopId: op.stopId })
      else if (op.op === 'SET_DETAILS') r.bundle = await updateStopDetails({ ...common, stopId: op.stopId, patch: op.patch })
      else r.bundle = await updateStop({ ...common, op: op.op, stopId: op.stopId, patch: op.patch })
    }
  }
  await r.run('stops', async () => {
    try {
      await runStopOps(before)
    } catch (err) {
      // "Stop not found": the page's copy of the load named a stop the server no longer has (the load changed since the page read it).
      // Read the load again, diff the form against what is really there and apply that once; anything else still fails as it did.
      if (!/^Stop not found/i.test(errorMessage(err))) throw err
      const fresh = await getShipmentBundle(bundle.shipment.id)
      r.bundle = fresh
      await runStopOps(valuesFromBundle(fresh, seed))
    }
  })
  await r.run('charges', async () => {
    if (locks.fields.rates || locks.fields.all) return
    const b = r.bundle!
    const next = chargesForBundle(values, b)
    if (eq(next, chargesForBundle(before, b))) return
    return recalcCharges({ shipmentId: b.shipment.id, expectedVersion: b.shipment.version ?? 0, charges: next })
  })
  await applyRoles(r, values)
  // Each booked carrier takes its own block; legs are only written when there is more than one carrier.
  await r.run('carrier', async () => {
    const slots = carrierSlotsOf(values)
    for (let i = 0; i < slots.length; i++) {
      const lc = loadCarrierOfSlot(r.bundle!, slots[i], i)
      const patch = lc ? carrierDetailsPatch(slots[i], lc, slots.length > 1) : null
      if (!lc || !patch) continue
      r.bundle = await updateLoadCarrierDetails({ loadCarrierId: lc.id, expectedUpdatedAt: lc.updatedAt, ...patch })
    }
  })
  await assignPickedDriver(r, values, ctx, bundle)
  await r.run('eta', async () => {
    const slots = carrierSlotsOf(values)
    const was = carrierSlotsOf(before)
    for (let i = 0; i < slots.length; i++) {
      const lc = loadCarrierOfSlot(r.bundle!, slots[i], i)
      if (!lc || slots[i].puEta === (was[i]?.puEta ?? '')) continue
      r.bundle = (await setEta({
        loadCarrierId: lc.id, expectedUpdatedAt: lc.updatedAt,
        pickupEtaAt: slots[i].puEta ? fromDateTimeInput(slots[i].puEta) : null,
      })).bundle
    }
  })
  return r.result()
}

/** Order submit, the first step of Submit for Review on a draft: validate for Submit, save strictly, then SUBMIT_ORDER. A refusal leaves the saved draft. */
export async function runSubmit(values: ShipmentFormValues, ctx: PipelineCtx, bundle: ShipmentBundle): Promise<PipelineResult> {
  const problem = precheck(values, ctx, 'submit', 'edit')
  if (problem) return fail(problem, bundle)
  const saved = await runEditSave(values, ctx, bundle)
  if (!saved.ok || !saved.bundle) return saved
  const r = new Runner(saved.bundle, new Set(), ['submit'])
  r.steps.push(...saved.steps)
  await r.run('submit', () => submitOrder({
    shipmentId: r.bundle!.shipment.id, expectedUpdatedAt: r.bundle!.shipment.updatedAt,
    ...(values.roles.dispatcherAssignedId ? { carrierRepId: values.roles.dispatcherAssignedId } : {}),
  }))
  return r.result()
}

/**
 * After a carrier was booked (BOOK_CARRIER for the first, ADD_CARRIER for the others): apply what the
 * booking cannot take (Seal, Carrier Ref #, PU ETA) and re-tie the per-assignment extras to the new
 * assignment, clearing that slot's pre-Cover rate draft. `slotKey` names the slot just booked (default: the first).
 */
export async function runCover(values: ShipmentFormValues, booked: ShipmentBundle, slotKey?: string): Promise<PipelineResult> {
  const slots = carrierSlotsOf(values)
  const index = Math.max(0, slots.findIndex((s) => s.slot === slotKey))
  const known = new Set(slots.map((s) => s.loadCarrierId).filter(Boolean))
  const live = liveCarriers(booked)
  // The assignment just booked: the first slot's is the primary; another slot's is the live one no slot owns yet.
  const lc = index === 0 ? live[0] : live.find((l) => !known.has(l.id))
  if (!lc) return fail('The carrier is not booked yet.', booked)
  const slot = slots[index]
  const r = new Runner(booked, new Set(), ['carrier', 'eta', 'extras'])
  await r.run('carrier', async () => {
    const patch = carrierDetailsPatch(slot, lc, slots.length > 1)
    if (!patch) return
    const active = liveCarriers(r.bundle).find((l) => l.id === lc.id)!
    return updateLoadCarrierDetails({ loadCarrierId: active.id, expectedUpdatedAt: active.updatedAt, ...patch })
  })
  await r.run('eta', async () => {
    if (!slot.puEta) return
    const active = liveCarriers(r.bundle).find((l) => l.id === lc.id)!
    return (await setEta({
      loadCarrierId: active.id, expectedUpdatedAt: active.updatedAt, pickupEtaAt: fromDateTimeInput(slot.puEta),
    })).bundle
  })
  await r.run('extras', async () => {
    const b = r.bundle!
    const tied = slots.map((s, i) => (i === index ? { ...s, loadCarrierId: lc.id } : s))
    const [first, ...rest] = tied
    const next: ShipmentFormValues = {
      ...values,
      carrier: { ...values.carrier, loadCarrierId: first.loadCarrierId || live[0].id },
      carriers: [first, ...rest],
    }
    const input = toUpdateOrderDetailsInput(next, b)
    return updateOrderDetails({ shipmentId: input.shipmentId, expectedUpdatedAt: input.expectedUpdatedAt, order: { specialRequirements: input.order?.specialRequirements } })
  })
  return r.result()
}

/**
 * Cover one extra carrier slot: ADD_CARRIER with the slot's directory carrier, rate, charges and legs, then
 * the same follow-up as the first carrier (`runCover`). The server decides whether the add is allowed.
 */
export async function runAddCarrier(values: ShipmentFormValues, bundle: ShipmentBundle, slotKey: string): Promise<PipelineResult> {
  const slot = carrierSlotsOf(values).find((s) => s.slot === slotKey)
  if (!slot) return fail('That carrier slot is gone.', bundle)
  if (!slot.carrierId) return fail('Pick the carrier from the directory first.', bundle)
  const r = new Runner(bundle, new Set(), ['add'])
  await r.run('add', () => addCarrier(toAddCarrierInput(values, slotKey, r.bundle!)))
  if (r.stopped || !r.bundle) return r.result()
  const after = await runCover(values, r.bundle, slotKey)
  return { ...after, steps: [...r.steps, ...after.steps] }
}
