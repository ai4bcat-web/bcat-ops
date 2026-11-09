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
import { AUTO_BLOCK_NOTE, autoRequestBlock, channelsAllowedBy, effectiveTrackingPrefs, type EffectiveTrackingPrefs, type TrackingMethod } from '../../../src/lib/trackingPrefs'
import { resolveDriverSms } from './driverPhone'
import { TZ } from '../../../src/lib/date'
import { carrierPhase, coveringCarrier } from '../../../src/lib/carrierLegs'
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
  /** The covering carrier's effective prefs. */
  prefs: EffectiveTrackingPrefs
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

/**
 * Milestones already said. The e-mail row carries an `:email` suffix, the SMS row does not, so a customer
 * whose method is EMAIL (or SMS) is only "done" with a milestone once that channel went out: switching
 * the method later must still send the channel that never did.
 */
function milestoneSentForLoad(loadId: string, messages: Row[], method: TrackingMethod | null): Record<string, true> {
  const prefix = `msg:${loadId}:`
  const sent: Record<string, true> = {}
  for (const message of messages) {
    const id = String(message.id ?? '')
    if (!id.startsWith(prefix)) continue
    const isEmail = id.endsWith(':email')
    if ((method === 'EMAIL' && !isEmail) || (method === 'SMS' && isEmail)) continue
    const milestone = id.slice(prefix.length).replace(/:email$/, '')
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

/** The ACTIVE rows of one load in assignment order (Step AT). */
export function liveCarriersOfLoad(load: Row, carriers: Row[]): Row[] {
  return carriers
    .filter((c) => c.loadId === load.id && c.status === 'ACTIVE')
    .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
}

/**
 * The carrier an automatic action on this load is about: with two or more live carriers, the one whose
 * leg holds the earliest un-departed stop; otherwise (and once every stop has left) the primary pointer,
 * exactly `activeLoadCarrier`. A single-carrier load never reaches the legs code.
 */
export function coveringLoadCarrier(load: Row, carriers: Row[]): Row | null {
  const live = liveCarriersOfLoad(load, carriers)
  if (live.length >= 2) {
    const holder = coveringCarrier(live as never[], parseStops(load) as never[])
    if (holder) return holder as Row
  }
  return activeLoadCarrier(load, carriers)
}

/** Who a cadence reminder goes to: every live carrier that has not finished its legs (covering one first); one carrier = that carrier. */
function reminderTargets(load: Row, carriers: Row[], covering: Row | null): Row[] {
  const live = liveCarriersOfLoad(load, carriers)
  if (live.length < 2) return covering ? [covering] : []
  const stops = parseStops(load) as never[]
  const open = live.filter((c) => carrierPhase({ legStopIds: c.legStopIds as string[] | undefined }, stops) !== 'DONE')
  if (open.length === 0) return covering ? [covering] : []
  return covering && open.some((c) => c.id === covering.id) ? [covering, ...open.filter((c) => c.id !== covering.id)] : open
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

function resolveTick(load: Row, plan: CheckCallPlan, messages: Row[], now: string, method: TrackingMethod | null): CheckCallTick {
  return nextCheckCallAction({
    plan,
    status: String(load.status ?? ''),
    lastCheckCallAt: load.lastCheckCallAt as string | null | undefined,
    milestonesSent: Object.keys(milestoneSentForLoad(String(load.id), messages, method)),
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

/** Sources that report a position without a person typing it: the driver's link or app, or the truck's ELD. */
const AUTOMATIC_SOURCES = new Set(['LINK', 'DRIVER_APP', 'MOTIVE'])

/** When the driver's last automatic update stops covering the cadence (ISO), or null when it is stale, absent or manual. */
export function driverUpdateFreshUntil(load: Row, intervalMs: number, nowMs: number): string | null {
  if (!AUTOMATIC_SOURCES.has(String(load.lastKnownSource ?? ''))) return null
  const at = Date.parse(String(load.lastKnownAt ?? ''))
  if (!Number.isFinite(at) || nowMs - at >= intervalMs) return null
  return new Date(at + intervalMs).toISOString()
}


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
    const carrier = coveringLoadCarrier(load, carriers)
    const prefs = effectiveTrackingPrefs({ shipment, customer, loadCarrier: carrier })
    const resolved = resolveAutomation({
      settings,
      customer,
      load,
      revDivision: optionalString(shipment.revDivision, 100),
      revSubdivision: optionalString(shipment.revSubdivision, 100),
    })
    const policy = resolved.policy
    const methodChannels = channelsAllowedBy(prefs.method, resolved.plan.channels)
    const enabled = methodChannels.filter(isChannelEnabled)
    const plan = enabled.length ? { ...resolved.plan, channels: methodChannels } : null
    let blocked: string | null = null
    if (auto) {
      const prefsBlock = autoRequestBlock(prefs)
      if (prefsBlock) blocked = AUTO_BLOCK_NOTE[prefsBlock]
      else if (!policy.checkCallsAuto) blocked = 'Automatic check calls are off'
      else if (!carrier || carrier.kind !== 'CARRIER' || carrier.status !== 'ACTIVE') blocked = 'Not a brokered carrier leg'
      else if (!isRateConSent(carrier)) blocked = 'Rate confirmation not sent'
    }
    if (blocked) {
      results.push({
        load,
        tick: { kind: 'NONE', milestone: null, channels: [], nextDueAt: null, reason: blocked },
        plan,
        carrier,
        prefs,
        policy,
        blocked,
      })
      continue
    }
    if (!plan) {
      const methodExcluded = resolved.plan.channels.some(isChannelEnabled) && !methodChannels.some(isChannelEnabled)
      results.push({
        load,
        tick: {
          kind: 'NONE',
          milestone: null,
          channels: [],
          nextDueAt: null,
          reason: methodExcluded ? 'Tracking method excludes every enabled channel' : 'No enabled channel',
        },
        plan: null,
        carrier,
        prefs,
        policy,
        blocked: null,
      })
      continue
    }
    let tick = resolveTick(load, plan, messages, deps.now(), prefs.method)
    // Optional (TmsSettings.checkCallSkipWhenDriverActive, off unless true): a cadence text is not needed while the driver's own
    // link, app or ELD keeps the position fresh, so it waits until a full interval passes with no automatic update.
    const quietUntil = settings?.checkCallSkipWhenDriverActive === true && tick.kind === 'CADENCE'
      ? driverUpdateFreshUntil(load, Math.max(1, plan.intervalHours * HOUR_MS), Date.parse(deps.now()))
      : null
    if (quietUntil) tick = { ...tick, kind: 'NONE', channels: [], nextDueAt: quietUntil, reason: 'Driver updated recently, no text needed' }
    // A person's run after the method changed: the slot already went out on the other channel only, so the
    // channel that never did is still owed (the claim id keeps it to once per slot).
    if (!auto && carrier && tick.kind === 'NONE' && tick.reason === 'Not due yet') {
      const slotIndex = cadenceSlot(load, Math.max(1, plan.intervalHours * HOUR_MS), Date.parse(deps.now())).index
      const slotId = (c: string) => `auto:cc:${carrier.id}:${slotIndex}:${c}`
      const spent = messages.some((m) => String(m.id ?? '').startsWith(`auto:cc:${carrier.id}:${slotIndex}:`))
      const owed = plan.channels.filter((c) => (c === 'SMS' || c === 'EMAIL') && isChannelEnabled(c) && !messages.some((m) => m.id === slotId(c)))
      if (spent && owed.length) tick = { ...tick, kind: 'CADENCE', channels: owed, reason: `Every ${plan.intervalHours} h in transit` }
    }
    results.push({ load, tick, plan, carrier, prefs, policy, blocked: null })
  }

  let acted = 0
  let deferred = 0
  let escalated = 0
  let skipped = 0
  const processed: Row[] = []

  for (const { load, tick, plan, carrier, prefs, policy, blocked } of results) {
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
      // `nextCheckCallAt` is the sort key of the check-call worklist index: DynamoDB refuses a NULL there, so "nothing due" is
      // the attribute removed, never null (a delivered load otherwise failed "Run check call now" with a ValidationError).
      await deps.transact([
        updateItemTx(
          deps.tables.load,
          loadId,
          {
            ...(next ? { nextCheckCallAt: next } : {}),
            updatedAt: now,
            updatedBy: caller.email,
          },
          String(load.updatedAt ?? ''),
          { remove: [...(next ? [] : ['nextCheckCallAt']), ...(keepOpen ? [] : ['checkCallOpen'])] },
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
        updateItemTx(deps.tables.load, loadId, withoutNullIndexKey({
          nextCheckCallAt: tick.nextDueAt,
          lastCheckCallAt: now,
          checkCallEscalatedAt: now,
          checkCallOpen: 'OPEN',
          updatedAt: now,
          updatedBy: caller.email,
        }).patch, String(load.updatedAt ?? ''), { remove: withoutNullIndexKey({ nextCheckCallAt: tick.nextDueAt }).remove }),
      ])
      processed.push({ loadId, kind: 'ESCALATE_DISPATCHER', reason, sent })
      continue
    }

    if (tick.kind === 'ESCALATE_EXCEPTION') {
      const reason = tick.reason
      escalated += 1
      acted += 1
      await deps.transact([
        updateItemTx(deps.tables.load, loadId, withoutNullIndexKey({
          nextCheckCallAt: tick.nextDueAt,
          checkCallFlaggedAt: now,
          checkCallFlagReason: reason,
          checkCallOpen: 'OPEN',
          updatedAt: now,
          updatedBy: caller.email,
        }).patch, String(load.updatedAt ?? ''), { remove: withoutNullIndexKey({ nextCheckCallAt: tick.nextDueAt }).remove }),
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

    // Step AT: a cadence reminder goes to every live carrier still moving freight, each on its own prefs.
    const targets = tick.kind === 'CADENCE' ? reminderTargets(load, carriers, carrier) : carrier ? [carrier] : []
    let wantsSms = false
    let smsReason: string | undefined
    let hasSmsAny = false
    let hasEmail = false
    let held = false
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
    for (const target of targets) {
      const isCovering = target === carrier
      const targetPrefs = isCovering ? prefs : effectiveTrackingPrefs({ shipment, customer, loadCarrier: target })
      if (!isCovering) {
        if (auto && autoRequestBlock(targetPrefs)) continue
        if (auto && (target.kind !== 'CARRIER' || !isRateConSent(target))) continue
      }
      const allow = <T extends string>(list: readonly T[]): T[] => (isCovering ? [...list] : channelsAllowedBy(targetPrefs.method, list))
      const tChannels = allow(tick.channels)
      const sendChannels = allow(channels)
      const targetSmsId = slot ? `auto:cc:${target.id}:${slot.index}:SMS` : smsId
      const targetEmailId = slot ? `auto:cc:${target.id}:${slot.index}:EMAIL` : emailId

      const dispatcherEmail = optionalString(target.dispatcherEmail, 250)
      const targetWantsSms = tChannels.includes('SMS')
      // Step AK: the truck's work phone first, the driver's own number as the fallback (per the carrier / shipment / customer override).
      const sms = targetWantsSms ? await resolveDriverSms(deps, { carrier: target, shipment, customer, load }) : null
      const hasSms = Boolean(sms?.to)
      const targetHasEmail = Boolean(dispatcherEmail && tChannels.includes('EMAIL'))
      wantsSms ||= targetWantsSms
      hasSmsAny ||= hasSms
      smsReason ??= targetWantsSms && !sms?.to ? sms?.reason ?? undefined : undefined
      hasEmail ||= targetHasEmail
      // A channel held back by quiet hours: nothing is stamped, so the next tick sends it if the slot is still open.
      held ||= (hasSms && !sendChannels.includes('SMS')) || (targetHasEmail && !sendChannels.includes('EMAIL'))

      if (hasSms && sendChannels.includes('SMS')) {
        track(knownIds.has(targetSmsId) ? null : await sendShipmentMessage(
          deps,
          {
            id: targetSmsId,
            shipmentId,
            loadId,
            loadCarrierId: target.id,
            channel: 'SMS',
            kind: 'CHECK_CALL',
            party: 'DRIVER',
            to: sms?.to,
            body,
            label: target,
            authorKind: 'AGENT',
          },
          caller,
        ))
      }
      if (targetHasEmail && sendChannels.includes('EMAIL')) {
        track(knownIds.has(targetEmailId) ? null : await sendShipmentMessage(
          deps,
          {
            id: targetEmailId,
            shipmentId,
            loadId,
            loadCarrierId: target.id,
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
    }

    if (attempted + covered === 0 && !held) {
      skipped += 1
      processed.push({ loadId, kind: 'NONE', reason: wantsSms && !hasSmsAny && !hasEmail ? smsReason ?? 'No driver phone' : 'No available channel' })
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
    const shared = withoutNullIndexKey(sharedUpdate)
    await deps.transact([
      updateItemTx(deps.tables.load, loadId, shared.patch, String(load.updatedAt ?? ''), { remove: shared.remove }),
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

/** `nextCheckCallAt` is the worklist index's sort key: DynamoDB refuses NULL there, so "nothing due" removes the attribute. */
function withoutNullIndexKey(patch: Row): { patch: Row; remove: string[] } {
  if (patch.nextCheckCallAt !== null) return { patch, remove: [] }
  const { nextCheckCallAt: _drop, ...rest } = patch
  void _drop
  return { patch: rest, remove: ['nextCheckCallAt'] }
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
