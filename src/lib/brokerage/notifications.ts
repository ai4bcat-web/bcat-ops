/**
 * Notification catalog, subscriptions and webhooks (Step L).
 *
 * The event catalog is code, not data: it lists only events the app can actually
 * produce today. Subscriptions (who gets which channel) and webhooks are stored.
 *
 * Pure: no store, no clock, no network except for signPayload's crypto. Imports
 * are relative because the tmsDirectoryActions Lambda bundles this file by path.
 */
/// <reference types="node" />
import { createHmac } from 'crypto'
import { isRoleKey } from '../roles'

export type NotificationChannel = 'EMAIL' | 'IN_APP' | 'WEBHOOK' | 'SMS' | 'PUSH'

export interface NotificationAudience {
  kind: 'ROLE' | 'TEAM' | 'USER'
  value: string
}

export interface NotificationSubscription {
  event: string
  channel: NotificationChannel
  audience: NotificationAudience
  enabled: boolean
}

export interface NotificationWebhook {
  id: string
  url: string
  events: string[]
  secretRef?: string | null
  secretLast4?: string | null
  active: boolean
  createdAt?: string | null
  createdBy?: string | null
  lastDeliveryAt?: string | null
  lastStatus?: string | null
  failureCount?: number | null
}

export interface EventCatalogEntry {
  event: string
  label: string
  producer: string
  channels: NotificationChannel[]
}

/** Events the app can produce today. Only the channels listed are offered. */
export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  { event: 'SHIPMENT_MILESTONE', label: 'Shipment milestone reached', producer: 'amplify/functions/shipment-notifier/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'POD_REQUEST', label: 'POD requested from carrier', producer: 'amplify/functions/shipment-notices.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'DOCUMENTS_REQUIRED', label: 'Documents required for a load', producer: 'amplify/functions/shipment-notifier/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'INVOICE_SENT', label: 'Invoice sent to customer', producer: 'src/lib/invoiceBuild.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'INVOICE_PAID', label: 'Invoice payment posted', producer: 'amplify/functions/tms-finance-actions/invoices.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'REMITTANCE_ADVICE', label: 'Remittance advice available', producer: 'amplify/functions/tms-finance-actions/invoices.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'CARRIER_OFFER', label: 'Carrier offer received', producer: 'amplify/functions/shipment-notifier/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'CHECK_CALL_DUE', label: 'Check call is due', producer: 'amplify/functions/check-call-notifier/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'CHECK_CALL_OVERDUE', label: 'Check call is overdue', producer: 'amplify/functions/check-call-notifier/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'AR_STATUS_CHANGE', label: 'AR status changed', producer: 'amplify/functions/tms-shipment-actions/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'AP_STATUS_CHANGE', label: 'AP status changed', producer: 'amplify/functions/tms-shipment-actions/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'WORKFLOW_EXCEPTION', label: 'Workflow run raised an exception', producer: 'amplify/functions/tms-workflow-actions/handler.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
  { event: 'INTEGRATION_UNHEALTHY', label: 'Integration became unhealthy', producer: 'amplify/functions/tms-directory-actions/integrations.ts', channels: ['EMAIL', 'IN_APP', 'WEBHOOK'] },
]

const EVENT_NAMES: readonly string[] = EVENT_CATALOG.map((e) => e.event)
const EVENT_CHANNELS: Record<string, NotificationChannel[]> = Object.fromEntries(
  EVENT_CATALOG.map((e) => [e.event, e.channels]),
)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SUBSCRIPTIONS = 200
const MAX_WEBHOOKS = 10

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function isEvent(value: string): boolean {
  return EVENT_NAMES.includes(value)
}

/** Staff record as seen by the notifiers. */
export interface NotificationStaff {
  email: string
  role?: string | null
  teamKeys?: string[] | null
}

/** Team record as seen by the notifiers. */
export interface NotificationTeam {
  key: string
  memberIds: string[]
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} is too long.`)
  return trimmed
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost') return true
  if (host.startsWith('10.')) return true
  if (host.startsWith('192.168.')) return true
  if (host.startsWith('169.254.')) return true
  const match = host.match(/^172\.(\d+)\.\d+\.\d+$/)
  if (match) {
    const second = Number(match[1])
    return second >= 16 && second <= 31
  }
  return false
}

/**
 * A webhook URL must be https and must not resolve to a private range by literal
 * form. We do not make a network request here; we just refuse obvious private hosts.
 */
export function validateWebhookUrl(url: string): string {
  if (!url) throw new Error('Webhook URL is required.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Webhook URL is not valid.')
  }
  if (parsed.protocol !== 'https:') throw new Error('Webhook URLs must use https.')
  const host = parsed.hostname.toLowerCase()
  if (isPrivateHost(host)) {
    throw new Error('Webhook URLs must not point to a private network address.')
  }
  return url
}

/**
 * Validate the stored subscription list. Unknown events and unavailable channels
 * are refused; SMS is listed in the catalog but refused until P8 settles the
 * dispatch number's use.
 */
export function validateNotificationSubscriptions(
  value: unknown,
  context: { teams?: { key: string }[] | null; staff?: NotificationStaff[] | null },
): NotificationSubscription[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Subscriptions must be a list.')
  if (value.length > MAX_SUBSCRIPTIONS) throw new Error(`At most ${MAX_SUBSCRIPTIONS} subscriptions are allowed.`)

  const teamKeys: Record<string, true> = {}
  for (const t of context?.teams ?? []) teamKeys[t.key.toLowerCase()] = true

  const out: NotificationSubscription[] = []
  for (let i = 0; i < value.length; i++) {
    const raw = asRecord(value[i])
    if (!raw) throw new Error(`Subscription ${i + 1} must be an object.`)

    const event = text(raw.event, 80, `Subscription ${i + 1} event`)
    if (!isEvent(event)) throw new Error(`"${event}" is not a known notification event.`)

    const channel = text(raw.channel, 20, `Subscription ${i + 1} channel`) as NotificationChannel
    if (channel === 'SMS') throw new Error('SMS notifications are not available — the dispatch number is for drivers.')
    if (channel === 'PUSH') throw new Error('Push notifications are not offered until a mobile shell for staff exists.')
    const allowed = EVENT_CHANNELS[event]
    if (!allowed.includes(channel)) {
      throw new Error(`"${channel}" is not available for ${event}.`)
    }

    const audienceRaw = asRecord(raw.audience)
    if (!audienceRaw) throw new Error(`Subscription ${i + 1} audience must be an object.`)
    const kind = text(audienceRaw.kind, 20, `Subscription ${i + 1} audience kind`)
    if (kind !== 'ROLE' && kind !== 'TEAM' && kind !== 'USER') {
      throw new Error(`Subscription ${i + 1} audience kind must be ROLE, TEAM or USER.`)
    }
    const audienceValue = text(audienceRaw.value, 200, `Subscription ${i + 1} audience value`)
    if (!audienceValue) throw new Error(`Subscription ${i + 1} audience needs a value.`)

    if (kind === 'ROLE' && !isRoleKey(audienceValue)) {
      throw new Error(`"${audienceValue}" is not a known role.`)
    }
    if (kind === 'TEAM' && !teamKeys[audienceValue.toLowerCase()]) {
      throw new Error(`"${audienceValue}" is not a known team key.`)
    }
    if (kind === 'USER' && !EMAIL_RE.test(audienceValue)) {
      throw new Error(`"${audienceValue}" is not an e-mail address.`)
    }

    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
    out.push({ event, channel, audience: { kind, value: audienceValue }, enabled })
  }
  return out
}

/**
 * Validate webhook endpoint rows. secretRef and secretLast4 are ignored if sent by
 * the caller; they are written only by ROTATE_WEBHOOK_SECRET.
 */
export function validateNotificationWebhooks(
  value: unknown,
  existing?: NotificationWebhook[] | null,
): NotificationWebhook[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Webhooks must be a list.')
  if (value.length > MAX_WEBHOOKS) throw new Error(`At most ${MAX_WEBHOOKS} webhooks are allowed.`)

  const existingById: Record<string, NotificationWebhook> = {}
  for (const w of existing ?? []) existingById[w.id] = w

  const out: NotificationWebhook[] = []
  for (let i = 0; i < value.length; i++) {
    const raw = asRecord(value[i])
    if (!raw) throw new Error(`Webhook ${i + 1} must be an object.`)

    const id = text(raw.id, 80, `Webhook ${i + 1} id`)
    if (!id) throw new Error(`Webhook ${i + 1} needs an id.`)

    const url = validateWebhookUrl(text(raw.url, 500, `Webhook ${i + 1} URL`))

    const eventsRaw = Array.isArray(raw.events) ? raw.events : []
    const events: string[] = []
    for (let j = 0; j < eventsRaw.length; j++) {
      const event = typeof eventsRaw[j] === 'string' ? String(eventsRaw[j]).trim() : ''
      if (!event) throw new Error(`Webhook ${i + 1} event ${j + 1} is blank.`)
      if (!isEvent(event)) throw new Error(`"${event}" is not a known notification event.`)
      events.push(event)
    }

    const prior = existingById[id]
    const active = typeof raw.active === 'boolean' ? raw.active : (prior?.active ?? true)

    out.push({
      id,
      url,
      events,
      secretRef: prior?.secretRef ?? null,
      secretLast4: prior?.secretLast4 ?? null,
      active,
      createdAt: prior?.createdAt ?? null,
      createdBy: prior?.createdBy ?? null,
      lastDeliveryAt: prior?.lastDeliveryAt ?? null,
      lastStatus: prior?.lastStatus ?? null,
      failureCount: prior?.failureCount ?? 0,
    })
  }
  return out
}

/**
 * Resolve the recipient e-mails for an event from the current subscriptions.
 * This is the default wiring used by the existing notifiers until the page lets
 * admins override it.
 */
export function recipientsFor(
  event: string,
  subscriptions: NotificationSubscription[] | null | undefined,
  staff: NotificationStaff[] | null | undefined,
  teams: NotificationTeam[] | null | undefined,
): string[] {
  const emails: Record<string, true> = {}
  const teamByKey: Record<string, NotificationTeam> = {}
  for (const t of teams ?? []) teamByKey[t.key.toLowerCase()] = t

  for (const sub of subscriptions ?? []) {
    if (!sub.enabled || sub.event !== event) continue
    if (sub.channel !== 'EMAIL' && sub.channel !== 'IN_APP') continue
    const { kind, value } = sub.audience
    if (kind === 'USER') {
      emails[value.toLowerCase()] = true
      continue
    }
    if (kind === 'ROLE') {
      for (const person of staff ?? []) {
        if (person.role?.toUpperCase() === value.toUpperCase()) {
          emails[person.email.toLowerCase()] = true
        }
      }
      continue
    }
    if (kind === 'TEAM') {
      const team = teamByKey[value.toLowerCase()]
      for (const member of team?.memberIds ?? []) {
        const email = member.trim().toLowerCase()
        if (email) emails[email] = true
      }
    }
  }

  // Today's default: if nobody is subscribed, every active staff member gets it.
  if (Object.keys(emails).length === 0) {
    for (const person of staff ?? []) {
      if (person.email) emails[person.email.toLowerCase()] = true
    }
  }

  return Object.keys(emails).sort()
}

/** Sign a webhook payload using the repo's shared HMAC-SHA256 convention. */
export function signPayload(secret: string, body: string, timestamp: number | string): string {
  const ts = String(timestamp)
  const base = `v0:${ts}:${body}`
  const hmac = createHmac('sha256', secret).update(base).digest('hex')
  return `v0=${hmac}`
}
