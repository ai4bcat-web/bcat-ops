/**
 * Tracking automation (Step V): one engine, two doors.
 *
 * `runTrackingAutomation` is what the scheduled Lambda runs (AUTO, unscoped), what the
 * Settings "Run automation now" button runs (AUTO), and what the dev verifier runs on a
 * handful of shipments (AUTO or MANUAL, scoped). It never sends anything the policy has
 * not switched on: every master switch defaults to OFF.
 *
 *   check-call pass  open loads whose next check call is due → runCheckCallPlan(AUTO)
 *   POD pass         recently DELIVERED shipments → one ask per leg per channel
 *
 * Every message goes through sendShipmentMessage, so it lands in the shipment's own
 * thread (threadKey, Reply-To plus-address) and replies come back the way they do today.
 */
import { renderTemplate, isQuietNow, isRateConSent, resolveAutomation } from '../../../src/lib/trackingAutomation'
import { MAX_SMS_BODY } from '../../../src/lib/dispatch'
import { allowsAutoRequests, channelsAllowedBy, effectiveTrackingPrefs } from '../../../src/lib/trackingPrefs'
import { resolveDriverSms } from './driverPhone'
import { isVoided } from '../_shared/voided'
import type { Caller } from '../_shared/actionInputs'
import type { Row } from '../_shared/shipmentStore'
import {
  activeLoadCarrier,
  activePingLink,
  runCheckCallPlan,
  templateVarsFor,
  type CheckCallDeps,
} from './checkCallAgent'
import { requestPodForLeg } from './podReview'
import { openShipmentThread } from './thread'

export const MAX_SCOPED_SHIPMENTS = 200
const MAX_REASONS = 50
/** How far back the POD pass looks for delivered shipments (by pickup appointment). */
export const POD_LOOKBACK_DAYS = 21

export interface AutomationDeps extends CheckCallDeps {
  /** Shipments with status DELIVERED and pickupAppt >= sinceIso (Shipment GSI status+pickupAppt). */
  queryDeliveredShipments(sinceIso: string): Promise<Row[]>
}

export interface AutomationResult {
  mode: 'AUTO' | 'MANUAL'
  checked: number
  acted: number
  deferred: number
  escalated: number
  skipped: number
  errors: number
  pod: { checked: number; requested: number; skipped: number; deferred: number }
  reasons: string[]
}

function parseInput(input: Row): { mode: 'AUTO' | 'MANUAL'; shipmentIds: string[] | null } {
  const mode = input.mode == null ? 'AUTO' : input.mode
  if (mode !== 'AUTO' && mode !== 'MANUAL') throw new Error("mode must be 'AUTO' or 'MANUAL'")
  let shipmentIds: string[] | null = null
  if (input.shipmentIds != null) {
    if (!Array.isArray(input.shipmentIds)) throw new Error('shipmentIds must be a list')
    shipmentIds = [...new Set(input.shipmentIds.map((v) => String(v ?? '').trim()).filter(Boolean))]
    if (shipmentIds.length > MAX_SCOPED_SHIPMENTS) {
      throw new Error(`shipmentIds is limited to ${MAX_SCOPED_SHIPMENTS} shipments per run`)
    }
  }
  return { mode, shipmentIds }
}

export async function runTrackingAutomation(deps: AutomationDeps, input: Row, caller: Caller): Promise<AutomationResult> {
  const { mode, shipmentIds: scoped } = parseInput(input)
  // MANUAL ignores the switches, quiet hours and the rate-con guard, so it is a person's call.
  if (mode === 'MANUAL' && !caller.isAdmin) throw new Error('Forbidden: MANUAL automation requires owner or ADMIN')

  const result: AutomationResult = {
    mode,
    checked: 0,
    acted: 0,
    deferred: 0,
    escalated: 0,
    skipped: 0,
    errors: 0,
    pod: { checked: 0, requested: 0, skipped: 0, deferred: 0 },
    reasons: [],
  }
  const note = (text: string) => {
    if (result.reasons.length < MAX_REASONS) result.reasons.push(text)
  }
  const fail = (shipmentId: string, err: unknown) => {
    result.errors += 1
    const message = err instanceof Error ? err.message : String(err)
    note(`${shipmentId}: ${message}`)
    deps.writeAudit('SHIPMENT', shipmentId, 'TRACKING_AUTOMATION_ERROR', caller, { error: message }).catch(() => undefined)
  }

  // ── Check-call pass ────────────────────────────────────────────────────────
  let checkCallIds = scoped
  if (!checkCallIds) {
    const now = deps.now()
    const open = await deps.queryIndex(deps.tables.load, 'loadsByCheckCallOpenAndNextCheckCallAt', 'checkCallOpen', 'OPEN')
    checkCallIds = [...new Set(open.filter((l) => String(l.nextCheckCallAt ?? '') <= now).map((l) => String(l.shipmentId)))]
  }
  for (const shipmentId of checkCallIds) {
    try {
      const shipment = await deps.getById(deps.tables.shipment, shipmentId)
      if (!shipment) {
        note(`${shipmentId}: shipment not found`)
        continue
      }
      if (mode === 'AUTO' && isVoided(shipment)) continue
      await openShipmentThread(deps, shipmentId, caller)
      const run = await runCheckCallPlan(deps, { shipmentId }, caller, { mode })
      result.checked += Number(run.checked ?? 0)
      result.acted += Number(run.acted ?? 0)
      result.escalated += Number(run.escalated ?? 0)
      result.skipped += Number(run.skipped ?? 0)
      result.deferred += Number(run.deferred ?? 0)
      for (const row of (run.processed as Row[] | undefined) ?? []) {
        if (row.kind === 'NONE' || row.kind === 'DEFERRED') note(`${String(shipment.number ?? shipmentId)}: ${String(row.reason ?? row.kind)}`)
      }
    } catch (err) {
      fail(shipmentId, err)
    }
  }

  // ── POD pass ───────────────────────────────────────────────────────────────
  if (mode === 'AUTO') {
    const nowIso = deps.now()
    let delivered: Row[]
    if (scoped) {
      delivered = []
      for (const id of scoped) {
        try {
          const row = await deps.getById(deps.tables.shipment, id)
          if (row && row.status === 'DELIVERED') delivered.push(row)
        } catch {
          // Already reported by the check-call pass.
        }
      }
    } else {
      const since = new Date(Date.parse(nowIso) - POD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
      delivered = await deps.queryDeliveredShipments(since)
    }
    let settings: Row | null = null
    const customers = new Map<string, Row | null>()
    for (const shipment of delivered) {
      const shipmentId = String(shipment.id)
      if (isVoided(shipment)) continue
      try {
        const [loads, carriers, thread] = await Promise.all([
          deps.queryIndex(deps.tables.load, 'loadsByShipmentId', 'shipmentId', shipmentId),
          deps.queryIndex(deps.tables.loadCarrier, 'loadCarriersByShipmentId', 'shipmentId', shipmentId),
          deps.queryIndex(deps.tables.message, 'shipmentMessagesByShipmentIdAndAt', 'shipmentId', shipmentId),
        ])
        for (const load of loads) {
          const carrier = activeLoadCarrier(load, carriers)
          if (!carrier || carrier.kind !== 'CARRIER' || carrier.status !== 'ACTIVE' || !isRateConSent(carrier)) continue
          result.pod.checked += 1

          // Step AJ: a manual customer is never asked automatically; the method trims the channels.
          const customerId = String(shipment.customerId ?? '')
          if (customerId && !customers.has(customerId)) customers.set(customerId, await deps.getById(deps.tables.customer, customerId))
          const customer = customerId ? customers.get(customerId) ?? null : null
          const prefs = effectiveTrackingPrefs({ shipment, customer })
          if (!allowsAutoRequests(prefs)) {
            result.pod.skipped += 1
            note(`${String(shipment.number ?? shipmentId)}: Customer tracking is manual`)
            continue
          }
          // Step AK: the driver is texted on the truck's work phone, personal as the fallback.
          const sms = await resolveDriverSms(deps, { carrier, shipment, customer, load })
          const recipients = channelsAllowedBy(prefs.method, ['EMAIL', 'SMS'] as const).filter((c) => (c === 'EMAIL' ? carrier.dispatcherEmail : sms.to))
          const pending: ('EMAIL' | 'SMS')[] = []
          for (const channel of recipients) {
            // One ask per leg per channel, whoever made it: an automatic claim, or a person's
            // REQUEST_POD already in the thread. (The notifier's upload-link e-mail is not in the thread and does not count — D-V7.)
            const asked = thread.some(
              (m) => m.kind === 'POD_REQUEST' && m.loadCarrierId === carrier.id && m.channel === channel && m.direction !== 'IN',
            )
            if (!asked && !(await deps.getById(deps.tables.message, `auto:pod:${carrier.id}:${channel}`))) pending.push(channel)
          }
          if (pending.length === 0) {
            result.pod.skipped += 1
            continue
          }

          settings ??= await deps.getSettings()
          const { policy } = resolveAutomation({
            settings,
            customer,
            load,
            revDivision: shipment.revDivision as string | null | undefined,
            revSubdivision: shipment.revSubdivision as string | null | undefined,
          })
          const wanted = pending.filter((c) => policy.podChannels.includes(c))
          if (!policy.podAuto || wanted.length === 0) {
            result.pod.skipped += 1
            continue
          }
          const nowMs = Date.parse(nowIso)
          const allowed = wanted.filter((c) => !isQuietNow(policy.quietHours, c, nowMs))
          if (allowed.length === 0) {
            result.pod.deferred += 1
            continue
          }

          const t = policy.templates
          const templates: { sms?: string; emailSubject?: string; emailBody?: string } = {}
          if (t.podSms || t.podEmailSubject || t.podEmailBody) {
            const link = t.podSms ? await activePingLink(deps, String(load.id)) : null
            const trackingUrl = link ? deps.trackingUrl(String(link.id)) : null
            const vars = await templateVarsFor(deps, { shipment, load, carrier, customer, trackingUrl })
            if (t.podSms) {
              const rendered = renderTemplate(t.podSms, vars)
              templates.sms = (trackingUrl && !t.podSms.includes('{trackingUrl}') ? `${rendered} ${trackingUrl}` : rendered).slice(0, MAX_SMS_BODY)
            }
            if (t.podEmailSubject) templates.emailSubject = renderTemplate(t.podEmailSubject, vars)
            if (t.podEmailBody) templates.emailBody = renderTemplate(t.podEmailBody, vars)
          }

          await openShipmentThread(deps, shipmentId, caller)
          const sent = await requestPodForLeg(deps, {
            shipment,
            load,
            carrier,
            idPrefix: 'auto:pod',
            channels: allowed,
            templates,
            sms,
            authorKind: 'AGENT',
            caller,
          })
          result.pod.requested += sent.requested
          if (sent.requested === 0) result.pod.skipped += 1
        }
      } catch (err) {
        fail(shipmentId, err)
      }
    }
  }

  return result
}
