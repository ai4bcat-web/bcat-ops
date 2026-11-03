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
import {
  isQuietNow,
  isRateConSent,
  renderTemplate,
  resolveAutomation,
  type AutomationPolicy,
  type TemplatePlaceholder,
} from '../../../src/lib/trackingAutomation'
import { MAX_SMS_BODY } from '../../../src/lib/dispatch'
import { TZ } from '../../../src/lib/date'
import { isVoided } from '../_shared/voided'
import { assertExpectedUpdatedAt, assertString, optionalString, type Caller } from '../_shared/actionInputs'
import { type Row, updateItemTx } from '../_shared/shipmentStore'
import { sendShipmentMessage, type ThreadDeps } from './thread'

export interface CheckCallDeps extends ThreadDeps {
  /** Build the publicly reachable URL for a tracking link token. */
  trackingUrl(token: string): string
  /** UserProfile by id (the shipment's tracker), for template placeholders. Absent = no tracker details. */
  getUserProfile?(id: string): Promise<Row | null>
}

export interface RunCheckCallOptions {
  /**
   * MANUAL (default) is a person pressing the button: no master switch, no quiet
   * hours, no rate-con guard. AUTO is the scheduled sweep and honours all three.
   */
  mode?: 'AUTO' | 'MANUAL'
}

interface TickResult {
  load: Row
  tick: CheckCallTick
  plan: CheckCallPlan | null
  carrier: Row | null
  policy: AutomationPolicy
  /** AUTO only: why this leg may not be touched at all (no write, nothing sent). */
  blocked: string | null
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

export function activeLoadCarrier(load: Row, carriers: Row[]): Row | null {
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

export async function activePingLink(deps: CheckCallDeps, loadId: string): Promise<Row | null> {
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

function stopOf(load: Row, type: 'pickup' | 'delivery'): Row | undefined {
  const stops = parseStops(load)
  return stops.find((s) => s.type === type) ?? stops[type === 'pickup' ? 0 : stops.length - 1]
}

function loadCity(load: Row, type: 'pickup' | 'delivery'): string | null {
  return ((stopOf(load, type)?.city ?? '') as string) || null
}

function stopPlace(load: Row, type: 'pickup' | 'delivery'): string {
  const stop = stopOf(load, type)
  return [stop?.city, stop?.state].filter((v) => typeof v === 'string' && v).join(', ')
}

function stopDate(load: Row, type: 'pickup' | 'delivery'): string {
  const appt = stopOf(load, type)?.appt
  const ms = typeof appt === 'string' ? Date.parse(appt) : NaN
  return Number.isNaN(ms) ? '' : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })
}

/** Placeholder values for the policy templates; shared with the POD pass. */
export async function templateVarsFor(
  deps: CheckCallDeps,
  ctx: { shipment: Row; load: Row; carrier: Row | null; customer: Row | null; trackingUrl: string | null },
): Promise<Partial<Record<TemplatePlaceholder, string>>> {
  const { shipment, load, carrier, customer, trackingUrl } = ctx
  const trackerId = optionalString(shipment.trackerId, 100)
  const tracker = trackerId && deps.getUserProfile ? await deps.getUserProfile(trackerId).catch(() => null) : null
  const lastLocation = [load.lastKnownCity, load.lastKnownState].filter((v) => typeof v === 'string' && v).join(', ')
  return {
    proNumber: String(shipment.number ?? shipment.id ?? ''),
    loadNumber: String(load.loadNumber ?? ''),
    origin: stopPlace(load, 'pickup'),
    destination: stopPlace(load, 'delivery'),
    pickupDate: stopDate(load, 'pickup'),
    deliveryDate: stopDate(load, 'delivery'),
    customer: String(customer?.name ?? ''),
    carrier: String(carrier?.carrierName ?? ''),
    driverName: String(carrier?.driverName ?? ''),
    lastLocation,
    trackerName: String(tracker?.name ?? ''),
    trackerPhone: String(tracker?.phone ?? ''),
    trackingUrl: trackingUrl ?? '',
  }
}

const HOUR_MS = 60 * 60 * 1000

/**
 * The cadence slot `now` falls in. Slots are anchored to when the agent took the leg
 * (`checkCallPlanStartedAt`, else the last check call, else now), so they never drift
 * with tick jitter: slot n is [anchor + n·interval, anchor + (n+1)·interval).
 * A channel sends at most once per slot (`auto:cc:<legId>:<slot>:<CHANNEL>` claims);
 * a NOT_SENT or FAILED attempt is still an attempt and occupies its slot.
 */
function cadenceSlot(load: Row, intervalMs: number, nowMs: number): { index: number; startMs: number; anchorIso: string } {
  const parse = (v: unknown) => (v ? Date.parse(String(v)) : NaN)
  let anchor = parse(load.checkCallPlanStartedAt)
  if (!Number.isFinite(anchor)) anchor = parse(load.lastCheckCallAt)
  if (!Number.isFinite(anchor) || anchor > nowMs) anchor = nowMs
  const index = Math.floor((nowMs - anchor) / intervalMs)
  return { index, startMs: anchor + index * intervalMs, anchorIso: new Date(anchor).toISOString() }
}

/** Perform one check-call tick for every load on the shipment. */
export async function runCheckCallPlan(
  deps: CheckCallDeps,
  input: Row,
  caller: Caller,
  opts: RunCheckCallOptions = {},
): Promise<Row> {
  const auto = opts.mode === 'AUTO'
  const shipmentId = assertString(input.shipmentId, 'shipmentId')
  const shipment = await deps.getById(deps.tables.shipment, shipmentId)
  if (!shipment) throw new Error(`Shipment not found: ${shipmentId}`)
  if (auto && isVoided(shipment)) {
    return { checked: 0, acted: 0, escalated: 0, skipped: 0, deferred: 0, reasons: ['Shipment is voided'], processed: [] }
  }

  const [loads, carriers, messages, settings, customer] = await Promise.all([
    deps.queryIndex(deps.tables.load, 'loadsByShipmentId', 'shipmentId', shipmentId),
    deps.queryIndex(deps.tables.loadCarrier, 'loadCarriersByShipmentId', 'shipmentId', shipmentId),
    deps.queryIndex(deps.tables.message, 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', shipmentId),
    deps.getSettings(),
    shipment.customerId ? deps.getById(deps.tables.customer, String(shipment.customerId)) : Promise.resolve(null),
  ])

  const knownIds = new Set(messages.map((m) => String(m.id ?? '')))
  const results: TickResult[] = []
  for (const load of loads) {
    const carrier = activeLoadCarrier(load, carriers)
    const resolved = resolveAutomation({
      settings,
      customer,
      load,
      revDivision: optionalString(shipment.revDivision, 100),
      revSubdivision: optionalString(shipment.revSubdivision, 100),
    })
    const policy = resolved.policy
    const enabled = resolved.plan.channels.filter(isChannelEnabled)
    const plan = enabled.length ? resolved.plan : null
    let blocked: string | null = null
    if (auto) {
      if (!policy.checkCallsAuto) blocked = 'Automatic check calls are off'
      else if (!carrier || carrier.kind !== 'CARRIER' || carrier.status !== 'ACTIVE') blocked = 'Not a brokered carrier leg'
      else if (!isRateConSent(carrier)) blocked = 'Rate confirmation not sent'
    }
    if (blocked) {
      results.push({
        load,
        tick: { kind: 'NONE', milestone: null, channels: [], nextDueAt: null, reason: blocked },
        plan,
        carrier,
        policy,
        blocked,
      })
      continue
    }
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
        policy,
        blocked: null,
      })
      continue
    }
    const tick = resolveTick(load, plan, messages, deps.now())
    results.push({ load, tick, plan, carrier, policy, blocked: null })
  }

  let acted = 0
  let deferred = 0
  let escalated = 0
  let skipped = 0
  const processed: Row[] = []

  for (const { load, tick, plan, carrier, policy, blocked } of results) {
    const now = deps.now()
    const loadId = String(load.id)
    const loadStatus = String(load.status ?? '')
    const inMotion = IN_MOTION[loadStatus]

    if (blocked) {
      skipped += 1
      processed.push({ loadId, kind: 'NONE', reason: blocked })
      continue
    }

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

    // AUTO: a quiet channel is held back, not skipped. If every channel is quiet nothing is
    // written, so the next sweep after the window ends finds the same tick still due.
    let channels = tick.channels
    if (auto && tick.kind !== 'ESCALATE_EXCEPTION') {
      const nowMs = Date.parse(now)
      channels = tick.channels.filter((c) => c === 'VOICE' || !isQuietNow(policy.quietHours, c, nowMs))
      if (tick.channels.length > 0 && channels.length === 0) {
        deferred += 1
        processed.push({ loadId, kind: 'DEFERRED', reason: 'Quiet hours' })
        continue
      }
    }

    const milestone = tick.milestone
    const link = await activePingLink(deps, loadId)
    const trackingUrl = link ? deps.trackingUrl(String(link.id)) : null
    const shipmentNumber = String(shipment.number ?? shipmentId)
    let body = checkCallSmsBody({
      shipmentNumber,
      kind: tick.kind,
      milestone,
      trackingUrl,
      originCity: loadCity(load, 'pickup'),
      destinationCity: loadCity(load, 'delivery'),
    })

    // Policy templates colour CADENCE check calls only (milestone and escalation wording stay built in).
    let emailSubject = `Load ${shipmentNumber}${milestone ? ` — ${milestone}` : ''}`
    let emailBody = body
    if (auto && tick.kind === 'CADENCE') {
      const t = policy.templates
      if (t.checkCallSms || t.checkCallEmailSubject || t.checkCallEmailBody) {
        const vars = await templateVarsFor(deps, { shipment, load, carrier, customer, trackingUrl })
        if (t.checkCallSms) {
          const rendered = renderTemplate(t.checkCallSms, vars)
          const withLink = trackingUrl && !t.checkCallSms.includes('{trackingUrl}') ? `${rendered} ${trackingUrl}` : rendered
          body = withLink.slice(0, MAX_SMS_BODY)
        }
        if (t.checkCallEmailSubject) emailSubject = renderTemplate(t.checkCallEmailSubject, vars)
        if (t.checkCallEmailBody) emailBody = renderTemplate(t.checkCallEmailBody, vars)
        else if (t.checkCallSms) emailBody = body
      }
    }

    const sharedUpdate: Row = {
      nextCheckCallAt: tick.nextDueAt,
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
      if (dispatcherEmail && channels.includes('EMAIL')) {
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

    // MILESTONE or CADENCE. Milestones keep their per-load ids; a cadence check call is a
    // per-slot, per-channel claim, so a repeat run in the same slot (a second "Run now", a
    // 5-minute tick after a refused send, a quiet-hours retry) can never send a channel twice.
    const nowMs = Date.parse(now)
    const intervalMs = Math.max(1, (plan?.intervalHours ?? 1) * HOUR_MS)
    const slot = tick.kind === 'CADENCE' ? cadenceSlot(load, intervalMs, nowMs) : null
    const smsId = slot
      ? `auto:cc:${carrier?.id}:${slot.index}:SMS`
      : milestoneMessageId(loadId, String(milestone))
    const emailId = slot
      ? `auto:cc:${carrier?.id}:${slot.index}:EMAIL`
      : `${milestoneMessageId(loadId, String(milestone))}:email`

    const dispatcherEmail = optionalString(carrier?.dispatcherEmail, 250)
    const hasSms = Boolean(carrier && carrier.driverPhone && tick.channels.includes('SMS'))
    const hasEmail = Boolean(dispatcherEmail && tick.channels.includes('EMAIL'))
    // A channel held back by quiet hours: nothing is stamped, so the next tick sends it if the slot is still open.
    const held = (hasSms && !channels.includes('SMS')) || (hasEmail && !channels.includes('EMAIL'))

    let attempted = 0 // new rows this run (SENT, NOT_SENT or FAILED alike)
    let covered = 0 // channels that already had their row for this slot
    let anySent = false
    const track = (outcome: Row | null) => {
      if (!outcome || outcome.status === 'DUPLICATE') {
        covered += 1
        return
      }
      attempted += 1
      if (outcome.status === 'SENT') anySent = true
    }
    if (hasSms && channels.includes('SMS')) {
      track(knownIds.has(smsId) ? null : await sendShipmentMessage(
        deps,
        {
          id: smsId,
          shipmentId,
          loadId,
          loadCarrierId: carrier!.id,
          channel: 'SMS',
          kind: 'CHECK_CALL',
          party: 'DRIVER',
          to: carrier!.driverPhone,
          body,
          label: carrier,
          authorKind: 'AGENT',
        },
        caller,
      ))
    }
    if (hasEmail && channels.includes('EMAIL')) {
      track(knownIds.has(emailId) ? null : await sendShipmentMessage(
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
          subject: emailSubject,
          body: emailBody,
          authorKind: 'AGENT',
        },
        caller,
      ))
    }

    if (attempted + covered === 0 && !held) {
      skipped += 1
      processed.push({ loadId, kind: 'NONE', reason: 'No available channel' })
      continue
    }

    if (held) {
      // Partial (or nothing yet) because of quiet hours. Only anchor the leg so the sweep keeps
      // finding it; lastCheckCallAt stays put, so the held channel still goes out later in the same slot.
      deferred += 1
      if (attempted > 0) acted += 1
      if (!load.checkCallPlanStartedAt || load.checkCallOpen !== 'OPEN' || !load.nextCheckCallAt) {
        await deps.transact([
          updateItemTx(deps.tables.load, loadId, {
            checkCallPlanStartedAt: load.checkCallPlanStartedAt || slot?.anchorIso || now,
            checkCallOpen: 'OPEN',
            nextCheckCallAt: load.nextCheckCallAt || now,
            updatedAt: now,
            updatedBy: caller.email,
          }, String(load.updatedAt ?? '')),
        ])
      }
      processed.push({ loadId, kind: attempted > 0 ? tick.kind : 'DEFERRED', milestone: milestone ?? undefined, reason: 'Quiet hours' })
      continue
    }

    // Every wanted channel has its row for this slot (sent or not): the slot is spent.
    // A cadence slot stamps its own start so lastCheckCallAt + interval is the next slot
    // boundary — what the Tracking table shows as the next check call.
    if (slot) {
      sharedUpdate.lastCheckCallAt = new Date(slot.startMs).toISOString()
      sharedUpdate.nextCheckCallAt = new Date(slot.startMs + intervalMs).toISOString()
      if (!load.checkCallPlanStartedAt) sharedUpdate.checkCallPlanStartedAt = slot.anchorIso
    }
    // The reply clock only starts when something actually reached a provider-accepted send.
    if (anySent) sharedUpdate.checkCallAwaitingSince = now
    await deps.transact([
      updateItemTx(deps.tables.load, loadId, sharedUpdate, String(load.updatedAt ?? '')),
    ])
    if (attempted > 0) {
      acted += 1
      processed.push({ loadId, kind: tick.kind, milestone: milestone ?? undefined, reason: tick.reason })
    } else {
      skipped += 1
      processed.push({ loadId, kind: 'NONE', reason: 'Already sent for this slot' })
    }
  }

  return { checked: results.length, acted, escalated, skipped, deferred, reasons: results.map((r) => r.tick.reason), processed }
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
