/**
 * The tracking agent (Step P8).
 *
 * One load at a time, it resolves the effective check-call plan and performs exactly
 * the next tick on the ladder. Every send is logged as a ShipmentMessage, every ask
 * sets the reply clock, and every silence of the configured length escalates once.
 */
import {
  CHECK_CALL_MILESTONES,
  checkCallSmsBody,
  isChannelEnabled,
  nextCheckCallAction,
  type CheckCallMilestone,
  type CheckCallPlan,
  type CheckCallTick,
} from '../../../src/lib/checkCallPlan'
import { resolveCheckCallPlan } from '../../../src/lib/flowDefaults'
import { assertExpectedUpdatedAt, assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { type Row, updateItemTx } from '../_shared/shipmentStore'
import { sendShipmentMessage, type ThreadDeps } from './thread'

export interface CheckCallDeps extends ThreadDeps {
  /** Build the publicly reachable URL for a tracking link token. */
  trackingUrl(token: string): string
}

interface TickResult {
  load: Row
  tick: CheckCallTick
  plan: CheckCallPlan | null
  carrier: Row | null
}

const IN_MOTION: Record<string, boolean> = {
  DISPATCHED: true,
  LOADING: true,
  PICKED_UP: true,
  IN_TRANSIT: true,
  RECOVERED: true,
  ARRIVED_AT_DELIVERY_TERMINAL: true,
  OUT_FOR_DELIVERY: true,
  UNLOADING: true,
}

function milestoneMessageId(loadId: string, milestone: string): string {
  return `msg:${loadId}:${milestone}`
}

function milestoneSentForLoad(loadId: string, messages: Row[]): Record<string, true> {
  const prefix = `msg:${loadId}:`
  const sent: Record<string, true> = {}
  for (const message of messages) {
    const id = String(message.id ?? '')
    if (!id.startsWith(prefix)) continue
    const milestone = id.slice(prefix.length)
    if (CHECK_CALL_MILESTONES.includes(milestone as CheckCallMilestone)) sent[milestone] = true
  }
  return sent
}

function activeLoadCarrier(load: Row, carriers: Row[]): Row | null {
  const activeId = optionalString(load.activeLoadCarrierId, 100)
  if (activeId) {
    const found = carriers.find((c) => c.id === activeId)
    if (found) return found
  }
  return carriers.find((c) => c.loadId === load.id && c.status === 'ACTIVE') ?? null
}

function parseStops(load: Row): Row[] {
  const raw = load.stops ?? '[]'
  try {
    return Array.isArray(raw) ? (raw as Row[]) : (JSON.parse(String(raw)) as Row[])
  } catch {
    return []
  }
}

async function activePingLink(deps: CheckCallDeps, loadId: string): Promise<Row | null> {
  const links = await deps.queryIndex(
    deps.tables.trackingLink,
    'trackingLinksByLoadId',
    'loadId',
    loadId,
  )
  return links.find((l) => l.kind === 'CARRIER_PING' && l.status === 'ACTIVE') ?? null
}

function resolveTick(load: Row, plan: CheckCallPlan, messages: Row[], now: string): CheckCallTick {
  return nextCheckCallAction({
    plan,
    status: String(load.status ?? ''),
    lastCheckCallAt: load.lastCheckCallAt as string | null | undefined,
    milestonesSent: Object.keys(milestoneSentForLoad(String(load.id), messages)),
    awaitingSince: load.checkCallAwaitingSince as string | null | undefined,
    escalatedAt: load.checkCallEscalatedAt as string | null | undefined,
    checkCallFlaggedAt: load.checkCallFlaggedAt as string | null | undefined,
    now,
  })
}

async function resolvePlanForLoad(
  deps: CheckCallDeps,
  load: Row,
  customer: Row | null,
  settings: Row | null,
): Promise<CheckCallPlan | null> {
  const plan = resolveCheckCallPlan(settings, customer, load)
  const enabled = plan.channels.filter(isChannelEnabled)
  return enabled.length ? plan : null
}

function loadCity(load: Row, type: 'pickup' | 'delivery'): string | null {
  const stops = parseStops(load)
  const stop = stops.find((s) => s.type === type) ?? stops[type === 'pickup' ? 0 : stops.length - 1]
  return ((stop?.city ?? '') as string) || null
}

/** Perform one check-call tick for every load on the shipment. */
export async function runCheckCallPlan(deps: CheckCallDeps, input: Row, caller: Caller): Promise<Row> {
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)

  const [loads, carriers, messages, settings, customer] = await Promise.all([
    deps.queryIndex(deps.tables.load, 'loadsByShipmentId', 'shipmentId', shipmentId),
    deps.queryIndex(deps.tables.loadCarrier, 'loadCarriersByShipmentId', 'shipmentId', shipmentId),
    deps.queryIndex(deps.tables.message, 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', shipmentId),
    deps.getSettings(),
    shipment.customerId ? deps.getById(deps.tables.customer, String(shipment.customerId)) : Promise.resolve(null),
  ])

  const results: TickResult[] = []
  for (const load of loads) {
    const carrier = activeLoadCarrier(load, carriers)
    const plan = await resolvePlanForLoad(deps, load, customer, settings)
    if (!plan) {
      results.push({
        load,
        tick: {
          kind: 'NONE',
          milestone: null,
          channels: [],
          nextDueAt: null,
          reason: 'No enabled channel',
        },
        plan: null,
        carrier,
      })
      continue
    }
    const tick = resolveTick(load, plan, messages, deps.now())
    results.push({ load, tick, plan, carrier })
  }

  let acted = 0
  let escalated = 0
  let skipped = 0
  const processed: Row[] = []

  for (const { load, tick, plan, carrier } of results) {
    const now = deps.now()
    const loadId = String(load.id)
    const loadStatus = String(load.status ?? '')
    const inMotion = IN_MOTION[loadStatus]

    if (tick.kind === 'NONE') {
      skipped += 1
      const next = tick.nextDueAt ?? null
      const keepOpen = inMotion && Boolean(next)
      await deps.transact([
        updateItemTx(
          deps.tables.load,
          loadId,
          {
            nextCheckCallAt: next,
            updatedAt: now,
            updatedBy: caller.email,
          },
          String(load.updatedAt ?? ''),
          keepOpen ? undefined : { remove: ['checkCallOpen'] },
        ),
      ])
      processed.push({ loadId, kind: 'NONE', reason: tick.reason })
      continue
    }

    const milestone = tick.milestone
    const link = await activePingLink(deps, loadId)
    const trackingUrl = link ? deps.trackingUrl(String(link.id)) : null
    const shipmentNumber = String(shipment.number ?? shipmentId)
    const body = checkCallSmsBody({
      shipmentNumber,
      kind: tick.kind,
      milestone,
      trackingUrl,
      originCity: loadCity(load, 'pickup'),
      destinationCity: loadCity(load, 'delivery'),
    })

    const sharedUpdate: Row = {
      nextCheckCallAt: tick.nextDueAt,
      checkCallAwaitingSince: now,
      checkCallOpen: 'OPEN',
      lastCheckCallAt: now,
      updatedAt: now,
      updatedBy: caller.email,
    }
    if (!load.checkCallPlanStartedAt) sharedUpdate.checkCallPlanStartedAt = now

    if (tick.kind === 'ESCALATE_DISPATCHER') {
      const reason = tick.reason
      const dispatcherEmail = optionalString(carrier?.dispatcherEmail, 250)
      let sent = false
      if (dispatcherEmail && tick.channels.includes('EMAIL')) {
        const text = `Following up on load ${shipmentNumber}: we have not heard from the driver. Please reply with the truck's current location.`
        const outcome = await sendShipmentMessage(
          deps,
          {
            id: `msg:${loadId}:${deps.randomId()}:dispatcher`,
            shipmentId,
            loadId,
            loadCarrierId: carrier?.id,
            channel: 'EMAIL',
            kind: 'ESCALATION',
            party: 'DISPATCHER',
            to: dispatcherEmail,
            subject: `Load ${shipmentNumber} — need location`,
            body: text,
            authorKind: 'AGENT',
          },
          caller,
        )
        sent = outcome.status === 'SENT'
      }
      acted += 1
      await deps.transact([
        updateItemTx(deps.tables.load, loadId, {
          nextCheckCallAt: tick.nextDueAt,
          lastCheckCallAt: now,
          checkCallEscalatedAt: now,
          checkCallOpen: 'OPEN',
          updatedAt: now,
          updatedBy: caller.email,
        }, String(load.updatedAt ?? '')),
      ])
      processed.push({ loadId, kind: 'ESCALATE_DISPATCHER', reason, sent })
      continue
    }

    if (tick.kind === 'ESCALATE_EXCEPTION') {
      const reason = tick.reason
      escalated += 1
      acted += 1
      await deps.transact([
        updateItemTx(deps.tables.load, loadId, {
          nextCheckCallAt: tick.nextDueAt,
          checkCallFlaggedAt: now,
          checkCallFlagReason: reason,
          checkCallOpen: 'OPEN',
          updatedAt: now,
          updatedBy: caller.email,
        }, String(load.updatedAt ?? '')),
        updateItemTx(deps.tables.shipment, shipmentId, {
          trackingFlaggedAt: now,
          trackingFlagReason: reason,
          updatedAt: now,
          updatedBy: caller.email,
        }, String(shipment.updatedAt ?? '')),
      ])
      processed.push({ loadId, kind: 'ESCALATE_EXCEPTION', reason })
      continue
    }

    // MILESTONE or CADENCE
    const smsId = milestone && tick.kind === 'MILESTONE'
      ? milestoneMessageId(loadId, milestone)
      : `msg:${loadId}:${deps.randomId()}`
    const emailId = milestone && tick.kind === 'MILESTONE'
      ? `${milestoneMessageId(loadId, milestone)}:email`
      : `msg:${loadId}:${deps.randomId()}:email`

    const dispatcherEmail = optionalString(carrier?.dispatcherEmail, 250)
    const outcomes: Row[] = []
    if (carrier && carrier.driverPhone && tick.channels.includes('SMS')) {
      outcomes.push(await sendShipmentMessage(
        deps,
        {
          id: smsId,
          shipmentId,
          loadId,
          loadCarrierId: carrier.id,
          channel: 'SMS',
          kind: 'CHECK_CALL',
          party: 'DRIVER',
          to: carrier.driverPhone,
          body,
          label: carrier,
          authorKind: 'AGENT',
        },
        caller,
      ))
    }
    if (dispatcherEmail && tick.channels.includes('EMAIL')) {
      outcomes.push(await sendShipmentMessage(
        deps,
        {
          id: emailId,
          shipmentId,
          loadId,
          loadCarrierId: carrier!.id,
          channel: 'EMAIL',
          kind: 'CHECK_CALL',
          party: 'DISPATCHER',
          to: dispatcherEmail,
          subject: `Load ${shipmentNumber}${milestone ? ` — ${milestone}` : ''}`,
          body,
          authorKind: 'AGENT',
        },
        caller,
      ))
    }

    if (outcomes.some((o) => o.status === 'SENT')) {
      acted += 1
      await deps.transact([
        updateItemTx(deps.tables.load, loadId, sharedUpdate, String(load.updatedAt ?? '')),
      ])
      if (milestone === 'DELIVERED' && ((plan as CheckCallPlan).requestPodOnDelivery ?? true)) {
        await requestPodForLoad(deps, load, carrier, caller)
      }
      processed.push({ loadId, kind: tick.kind, milestone: milestone ?? undefined, reason: tick.reason })
    } else {
      skipped += 1
      processed.push({ loadId, kind: 'NONE', reason: outcomes.length > 0 ? 'Send refused' : 'No available channel' })
    }
  }

  return { checked: results.length, acted, escalated, skipped, reasons: results.map((r) => r.tick.reason), processed }
}

export interface SweepResult {
  checked: number
  acted: number
  escalated: number
  skipped: number
  errors: number
}

/** Walk the open worklist and run every load whose next check call is due. */
export async function sweepCheckCallPlans(deps: CheckCallDeps, caller: Caller): Promise<Row> {
  const now = deps.now()
  const open = await deps.queryIndex(
    deps.tables.load,
    'loadsByCheckCallOpenAndNextCheckCallAt',
    'checkCallOpen',
    'OPEN',
  )
  const due = open.filter((l) => String(l.nextCheckCallAt ?? '') <= now)
  const shipmentIds = [...new Set(due.map((l) => String(l.shipmentId)))]

  const result: SweepResult & Record<string, unknown> = { checked: 0, acted: 0, escalated: 0, skipped: 0, errors: 0 }
  for (const shipmentId of shipmentIds) {
    try {
      const run = (await runCheckCallPlan(deps, { shipmentId }, caller)) as unknown as SweepResult
      result.checked += run.checked ?? 0
      result.acted += run.acted ?? 0
      result.escalated += run.escalated ?? 0
      result.skipped += run.skipped ?? 0
    } catch (err) {
      result.errors += 1
      deps.writeAudit('LOAD', shipmentId, 'CHECK_CALL_SWEEEP_ERROR', caller, {
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    }
  }
  return result
}

export async function saveCheckCallPlan(deps: CheckCallDeps, input: Row, caller: Caller): Promise<Row> {
  const loadId = assertString(input.loadId, 'loadId')
  const expectedUpdatedAt = assertExpectedUpdatedAt(input)
  const rawPlan = input.plan
  const plan = rawPlan == null ? null : resolveCheckCallPlan(null, null, { checkCallPlan: rawPlan })

  const load = await deps.getById(deps.tables.load, loadId)
  if (!load) throw new Error(`Load not found: ${loadId}`)

  await deps.transact([
    updateItemTx(
      deps.tables.load,
      loadId,
      {
        checkCallPlan: plan == null ? null : JSON.stringify(plan),
        updatedAt: deps.now(),
        updatedBy: caller.email,
      },
      expectedUpdatedAt,
    ),
  ])

  return { loadId, plan }
}

async function requestPodForLoad(
  deps: CheckCallDeps,
  load: Row,
  carrier: Row | null,
  caller: Caller,
  reason?: string,
): Promise<void> {
  const shipmentId = String(load.shipmentId)
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) return
  const shipmentNumber = String(shipment.number ?? shipmentId)
  const loadId = String(load.id)
  const base = `Please upload the signed POD for load ${shipmentNumber}${load.loadNumber ? ` (${load.loadNumber})` : ''}. Reply with photos or use your upload link.`
  const text = reason ? `Last POD was rejected: ${reason}. ${base}` : base

  if (carrier && carrier.dispatcherEmail) {
    await sendShipmentMessage(
      deps,
      {
        shipmentId,
        loadId,
        loadCarrierId: carrier.id,
        channel: 'EMAIL',
        kind: 'POD_REQUEST',
        party: 'DISPATCHER',
        to: carrier.dispatcherEmail,
        subject: `Load ${shipmentNumber} — POD needed`,
        body: text,
        authorKind: 'AGENT',
      },
      caller,
    )
  }
  if (carrier && carrier.driverPhone) {
    await sendShipmentMessage(
      deps,
      {
        shipmentId,
        loadId,
        loadCarrierId: carrier.id,
        channel: 'SMS',
        kind: 'POD_REQUEST',
        party: 'DRIVER',
        to: carrier.driverPhone,
        body: text,
        label: carrier,
        authorKind: 'AGENT',
      },
      caller,
    )
  }

  if (carrier) {
    await deps.transact([
      updateItemTx(
        deps.tables.loadCarrier,
        String(carrier.id),
        {
          podRequestedAt: deps.now(),
          updatedAt: deps.now(),
          updatedBy: caller.email,
        },
        String(carrier.updatedAt ?? ''),
      ),
    ])
  }
}
