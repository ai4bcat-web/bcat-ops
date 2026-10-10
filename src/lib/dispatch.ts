/**
 * Dispatch: the office texting and calling drivers through one Twilio number.
 *
 * Pure helpers shared by the Twilio webhook Lambda, the dispatch-actions Lambda and the
 * Dispatch page. Nothing here touches the network, so every rule about how a number maps
 * to a driver, what a conversation row shows, and how a message is summarised is tested
 * once and behaves the same on both ends.
 */

export type DispatchDirection = 'IN' | 'OUT'
export type DispatchKind = 'SMS' | 'MMS' | 'CALL' | 'VOICEMAIL' | 'NOTE' | 'STATUS'

export interface DispatchMedia {
  key: string
  contentType: string
  name?: string
}

export interface DispatchConversation {
  id: string
  phone: string
  driverId?: string | null
  driverName?: string | null
  displayName?: string | null
  status?: 'OPEN' | 'ARCHIVED' | null
  lastMessageAt?: string | null
  lastPreview?: string | null
  lastDirection?: DispatchDirection | null
  lastKind?: DispatchKind | string | null
  /** Who sent the last outbound message (staff email), for the list. */
  lastSentBy?: string | null
  unreadCount?: number | null
  /** Primary dispatcher (staff email). */
  assignedTo?: string | null
  /** Backup dispatcher, pinged when the primary has not answered either. */
  assignedBackup?: string | null
  nudgedFor?: string | null
  nudgeStage?: number | null
  lastReadAt?: string | null
  lastReadBy?: string | null
  /** The driver's own Slack channel, once the bridge has made it. */
  slackChannelId?: string | null
  slackChannelName?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface DispatchMessage {
  id: string
  conversationId: string
  phone: string
  direction: DispatchDirection
  kind: DispatchKind
  body?: string | null
  media?: DispatchMedia[] | null
  twilioSid?: string | null
  status?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  sentBy?: string | null
  at: string
  callDurationSec?: number | null
  recordingKey?: string | null
  transcript?: string | null
  /** Where an outbound message was typed: the page, or a driver's Slack channel. */
  via?: 'app' | 'slack' | null
  /** Slack message ts when it was typed in, or mirrored to, the driver's channel. */
  slackTs?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface DispatchForward {
  name: string
  phone: string
}

export interface DispatchSettings {
  id?: string
  forwardTo?: DispatchForward[] | null
  ringSeconds?: number | null
  greeting?: string | null
  voicemailEnabled?: boolean | null
  slackChannelId?: string | null
  autoReply?: string | null
  /** One Slack channel per driver, mirrored both ways. Default on. */
  slackMirror?: boolean | null
  /** Staff emails invited into every driver channel as it is created. */
  slackInviteEmails?: string[] | null
  updatedAt?: string
}

/** A Slack message starting with this is kept as an internal note, never texted. */
export const SLACK_NOTE_PREFIX = '//'
export const MAX_SLACK_INVITES = 25

/** What the voicemail prompt says when the office has not written its own. */
export const DEFAULT_GREETING =
  'You have reached BCAT dispatch. Nobody could pick up right now. Leave your name, truck number and what you need after the tone, and dispatch will call you back.'
export const DEFAULT_RING_SECONDS = 25
export const MIN_RING_SECONDS = 10
export const MAX_RING_SECONDS = 55
/** Twilio's hard ceiling for an SMS body before it is split into many segments. */
export const MAX_SMS_BODY = 1600
export const MAX_FORWARD_NUMBERS = 10
export const MAX_MEDIA_PER_MESSAGE = 5
/** Twilio rejects MMS attachments above this. */
export const MAX_MMS_BYTES = 5 * 1024 * 1024

// ── Phones ───────────────────────────────────────────────────────────────────

/** The ten national digits of a US number, or null when the input is not one. */
export function phoneDigits(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return digits
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  return null
}

/** Strict E.164 for a US number, or null. Unlike toE164 it refuses to guess. */
export function toE164Strict(raw: string | null | undefined): string | null {
  const d = phoneDigits(raw)
  return d ? `+1${d}` : null
}

/** (XXX) XXX-XXXX, or the input when it is not a US number. */
export function prettyPhone(raw: string | null | undefined): string {
  const d = phoneDigits(raw)
  if (!d) return raw ?? ''
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** Two numbers are the same line when their national digits agree. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = phoneDigits(a)
  return da !== null && da === phoneDigits(b)
}

// ── Drivers ──────────────────────────────────────────────────────────────────

export interface DispatchDriver {
  id: string
  name: string
  phone: string
  active?: boolean | null
  /** Dedicated dispatcher and backup (staff emails), when set on the driver. */
  dispatcherPrimary?: string | null
  dispatcherBackup?: string | null
}

/** The people who should see a driver's conversation by default: dispatcher, then backup. */
export function dispatchersOf(d: Pick<DispatchDriver, 'dispatcherPrimary' | 'dispatcherBackup'> | null | undefined): string[] {
  const out: string[] = []
  for (const e of [d?.dispatcherPrimary, d?.dispatcherBackup]) {
    const v = (e ?? '').trim().toLowerCase()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * The driver on a number. Active drivers win over inactive ones so a number handed from
 * a departed driver to a new hire resolves to the person actually carrying the phone.
 */
export function matchDriverByPhone<D extends DispatchDriver>(drivers: readonly D[], phone: string): D | null {
  const want = phoneDigits(phone)
  if (!want) return null
  const hits = drivers.filter((d) => phoneDigits(d.phone) === want)
  if (hits.length === 0) return null
  return hits.find((d) => d.active !== false) ?? hits[0]
}

// ── Display ──────────────────────────────────────────────────────────────────

/**
 * A stable colour slot (0..n-1) for a number nobody is linked to, so the same unknown
 * line always looks the same in the list. Linked drivers use their own colour key.
 */
export function phoneColorSlot(phone: string, slots: number): number {
  const d = phoneDigits(phone) ?? phone
  let h = 0
  for (const ch of d) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return slots > 0 ? h % slots : 0
}

/** What a conversation is called in the list: the driver, else a staff label, else the number. */
export function conversationTitle(c: Pick<DispatchConversation, 'phone' | 'driverName' | 'displayName'>): string {
  return (c.driverName?.trim() || c.displayName?.trim() || prettyPhone(c.phone))
}

/** Seconds as m:ss. */
export function formatDuration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One line that stands in for a message in the conversation list. */
export function messagePreview(m: Pick<DispatchMessage, 'kind' | 'direction' | 'body' | 'media' | 'status' | 'callDurationSec'>): string {
  switch (m.kind) {
    case 'CALL': {
      if (m.status === 'missed') return 'Missed call'
      if (m.status === 'answered') return `Call answered (${formatDuration(m.callDurationSec)})`
      if (m.status === 'voicemail') return 'Call went to voicemail'
      return m.direction === 'IN' ? 'Incoming call' : 'Outgoing call'
    }
    case 'VOICEMAIL':
      return m.body?.trim() ? `Voicemail: ${truncate(m.body.trim(), 80)}` : `Voicemail (${formatDuration(m.callDurationSec)})`
    case 'NOTE':
      return `Note: ${truncate((m.body ?? '').trim(), 80)}`
    case 'STATUS':
      return truncate((m.body ?? '').trim(), 120)
    default: {
      const text = (m.body ?? '').trim()
      const n = m.media?.length ?? 0
      if (text) return truncate(text, 100)
      if (n === 1) return 'Photo'
      if (n > 1) return `${n} photos`
      return ''
    }
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`
}

/** Messages in the order a thread reads: oldest first, ties broken by id for stability. */
export function sortThread<M extends Pick<DispatchMessage, 'at' | 'id'>>(messages: readonly M[]): M[] {
  return [...messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Conversations in worklist order: unread first, then most recent activity. Archived rows
 * are the caller's problem to filter; this only orders.
 */
export function sortConversations<C extends Pick<DispatchConversation, 'unreadCount' | 'lastMessageAt' | 'createdAt' | 'id'>>(rows: readonly C[]): C[] {
  return [...rows].sort((a, b) => {
    const ua = (a.unreadCount ?? 0) > 0 ? 1 : 0
    const ub = (b.unreadCount ?? 0) > 0 ? 1 : 0
    if (ua !== ub) return ub - ua
    const ta = a.lastMessageAt ?? a.createdAt ?? ''
    const tb = b.lastMessageAt ?? b.createdAt ?? ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return a.id < b.id ? -1 : 1
  })
}

/** Does a conversation match a search box? Name, label, number digits, assignee. */
export function conversationMatches(c: DispatchConversation, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  if (digits.length >= 3 && (phoneDigits(c.phone) ?? c.phone).includes(digits)) return true
  return [c.driverName, c.displayName, c.assignedTo, c.lastPreview]
    .some((v) => (v ?? '').toLowerCase().includes(q))
}

// ── Settings validation ──────────────────────────────────────────────────────

export interface SettingsProblem { field: string; message: string }

/** Clean a settings draft, returning the saved shape or the first thing wrong with it. */
export function normalizeSettings(input: Partial<DispatchSettings>): { ok: true; value: DispatchSettings } | { ok: false; problem: SettingsProblem } {
  const forwards: DispatchForward[] = []
  for (const f of input.forwardTo ?? []) {
    const phone = toE164Strict(f?.phone)
    if (!phone) return { ok: false, problem: { field: 'forwardTo', message: `"${f?.phone ?? ''}" is not a US phone number` } }
    if (forwards.some((x) => x.phone === phone)) continue
    forwards.push({ name: (f.name ?? '').trim().slice(0, 60), phone })
  }
  if (forwards.length > MAX_FORWARD_NUMBERS) {
    return { ok: false, problem: { field: 'forwardTo', message: `At most ${MAX_FORWARD_NUMBERS} phones can ring` } }
  }
  const ring = Math.round(Number(input.ringSeconds ?? DEFAULT_RING_SECONDS))
  if (!Number.isFinite(ring) || ring < MIN_RING_SECONDS || ring > MAX_RING_SECONDS) {
    return { ok: false, problem: { field: 'ringSeconds', message: `Ring time must be between ${MIN_RING_SECONDS} and ${MAX_RING_SECONDS} seconds` } }
  }
  const greeting = (input.greeting ?? '').trim().slice(0, 600)
  const autoReply = (input.autoReply ?? '').trim().slice(0, 320)
  const slack = (input.slackChannelId ?? '').trim()
  if (slack && !/^[CG][A-Z0-9]{6,}$/.test(slack)) {
    return { ok: false, problem: { field: 'slackChannelId', message: 'Slack channel IDs look like C0123ABCDEF' } }
  }
  const invites: string[] = []
  for (const raw of input.slackInviteEmails ?? []) {
    const e = String(raw ?? '').trim().toLowerCase()
    if (!e) continue
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, problem: { field: 'slackInviteEmails', message: `"${raw}" is not an email address` } }
    if (!invites.includes(e)) invites.push(e)
  }
  if (invites.length > MAX_SLACK_INVITES) return { ok: false, problem: { field: 'slackInviteEmails', message: `At most ${MAX_SLACK_INVITES} people can be auto-invited` } }
  return {
    ok: true,
    value: {
      forwardTo: forwards,
      ringSeconds: ring,
      greeting: greeting || null,
      voicemailEnabled: input.voicemailEnabled !== false,
      slackChannelId: slack || null,
      autoReply: autoReply || null,
      slackMirror: input.slackMirror !== false,
      slackInviteEmails: invites,
    },
  }
}

/**
 * The Slack channel a driver's conversation lives in: drv-jason-smith, or the number for
 * a line nobody is linked to yet. Slack allows lowercase letters, digits and dashes, 80 max.
 */
export function slackChannelNameFor(c: Pick<DispatchConversation, 'phone' | 'driverName' | 'displayName'>): string {
  const base = (c.driverName?.trim() || c.displayName?.trim() || '')
  const slug = base.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const d = phoneDigits(c.phone)
  const tail = slug || (d ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : 'unknown')
  return `drv-${tail}`.slice(0, 80).replace(/-+$/, '')
}

/** Is a Slack message an internal note (never texted)? Returns the note body, or null. */
export function slackNoteBody(text: string): string | null {
  const t = text.trim()
  if (!t.startsWith(SLACK_NOTE_PREFIX)) return null
  return t.slice(SLACK_NOTE_PREFIX.length).trim() || null
}

/** What a voice call should do, from the settings as saved. */
export function callPlan(settings: DispatchSettings | null | undefined): { ring: DispatchForward[]; ringSeconds: number; voicemail: boolean; greeting: string } {
  const ring = (settings?.forwardTo ?? []).filter((f) => toE164Strict(f.phone))
  return {
    ring,
    ringSeconds: settings?.ringSeconds ?? DEFAULT_RING_SECONDS,
    voicemail: settings?.voicemailEnabled !== false,
    greeting: settings?.greeting?.trim() || DEFAULT_GREETING,
  }
}
