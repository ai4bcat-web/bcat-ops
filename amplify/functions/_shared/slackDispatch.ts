/**
 * The Slack side of Dispatch: one channel per driver, mirrored both ways.
 *
 *   driver texts in  → posted in the driver's channel, once the office has created it
 *                      from the Dispatch page wizard (pictures and voicemails uploaded)
 *   staff types there → texted to the driver (see dispatch-slack-bridge)
 *   staff sends from the page → mirrored into the channel so Slack readers see it
 *
 * Pure parts (channel naming, event classification, message formatting) live apart from
 * the API calls so they are tested without Slack.
 */
import type { DispatchConversation, DispatchMessage, DispatchSettings } from '../../../src/lib/dispatch'
import { conversationTitle, formatDuration, prettyPhone, slackChannelNameFor, slackNoteBody } from '../../../src/lib/dispatch'
import type { DispatchStore } from './dispatchStore'
import { SlackError, type SlackClient } from './slackApi'

export const SLACK_TEAM_ID = 'TJ8NF616K'
export const SLACK_WORKSPACE_URL = 'https://bcatcorp.slack.com'

export function slackChannelUrl(channelId: string): string {
  return `${SLACK_WORKSPACE_URL}/archives/${channelId}`
}

// ── Inbound Slack events ────────────────────────────────────────────────────

export interface SlackFile { id?: string; name?: string; mimetype?: string; url_private?: string; size?: number }

export interface SlackMessageEvent {
  type?: string
  subtype?: string
  channel?: string
  user?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: SlackFile[]
}

export type SlackIntent =
  | { kind: 'skip'; reason: string }
  | { kind: 'text'; channel: string; user: string; ts: string; body: string; files: SlackFile[] }
  | { kind: 'note'; channel: string; user: string; ts: string; body: string }

/** What a Slack message in a driver channel asks us to do. Bots, edits and joins are noise. */
export function classifySlackEvent(ev: SlackMessageEvent): SlackIntent {
  if (ev.type !== 'message') return { kind: 'skip', reason: 'not a message' }
  if (ev.bot_id) return { kind: 'skip', reason: 'bot' }
  if (ev.subtype && ev.subtype !== 'file_share') return { kind: 'skip', reason: `subtype ${ev.subtype}` }
  if (!ev.channel || !ev.user || !ev.ts) return { kind: 'skip', reason: 'incomplete' }
  const text = (ev.text ?? '').trim()
  const files = (ev.files ?? []).filter((f) => f.url_private)
  const note = slackNoteBody(text)
  if (note) return { kind: 'note', channel: ev.channel, user: ev.user, ts: ev.ts, body: note }
  if (!text && files.length === 0) return { kind: 'skip', reason: 'empty' }
  return { kind: 'text', channel: ev.channel, user: ev.user, ts: ev.ts, body: text, files }
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** The Slack line for something a driver sent or did. */
export function formatInbound(m: Pick<DispatchMessage, 'kind' | 'body' | 'media' | 'status' | 'callDurationSec' | 'transcript'>): string {
  switch (m.kind) {
    case 'CALL':
      if (m.status === 'answered') return `📞 Call answered (${formatDuration(m.callDurationSec)})`
      if (m.status === 'missed' || m.status === 'voicemail') return '📵 Missed call'
      return '📞 Calling dispatch…'
    case 'VOICEMAIL':
      return m.transcript ? `🎙️ Voicemail (${formatDuration(m.callDurationSec)}): _${m.transcript}_` : `🎙️ Voicemail (${formatDuration(m.callDurationSec)}) — transcript coming`
    default: {
      const text = (m.body ?? '').trim()
      const n = m.media?.length ?? 0
      if (text && n) return `📱 ${text}\n_(${n} attachment${n === 1 ? '' : 's'} below)_`
      if (text) return `📱 ${text}`
      return n ? `📱 _(${n} attachment${n === 1 ? '' : 's'} below)_` : '📱 _(empty text)_'
    }
  }
}

/** The Slack line for something staff sent from the page (so Slack readers stay in sync). */
export function formatOutbound(m: Pick<DispatchMessage, 'kind' | 'body' | 'media'>, senderName: string): string {
  const text = (m.body ?? '').trim()
  if (m.kind === 'NOTE') return `📝 *${senderName}* (note, not texted): ${text}`
  const n = m.media?.length ?? 0
  const att = n ? ` _(+${n} attachment${n === 1 ? '' : 's'})_` : ''
  return `💬 *${senderName}* (BCAT Ops): ${text}${att}`
}

export function formatDeliveryFailure(m: Pick<DispatchMessage, 'body' | 'errorMessage' | 'errorCode'>): string {
  const why = m.errorMessage ?? (m.errorCode ? `Twilio error ${m.errorCode}` : 'unknown reason')
  const what = (m.body ?? '').trim()
  return `⚠️ Not delivered${what ? ` ("${what.slice(0, 60)}${what.length > 60 ? '…' : ''}")` : ''}: ${why}`
}

// ── Channel lifecycle ───────────────────────────────────────────────────────

export interface SlackBridgeDeps {
  slack: SlackClient
  store: DispatchStore
  settings: DispatchSettings | null
}

/** Is the bridge on? Settings default it on; a missing bot token turns it off upstream. */
export function slackMirrorEnabled(settings: DispatchSettings | null | undefined): boolean {
  return settings?.slackMirror !== false
}

/** Slack's rules for a channel name, applied to what the wizard typed. */
export function cleanChannelName(raw: string): string {
  const slug = raw.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/^#/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 80).replace(/-+$/, '')
}

export interface CreateChannelInput {
  /** Channel name from the wizard; falls back to drv-<driver>. */
  name?: string | null
  /** Everyone to invite: the defaults plus whoever the wizard added. */
  inviteEmails: readonly string[]
  /** The thread so far, posted as a recap so the channel is not born empty. */
  recap?: readonly DispatchMessage[]
}

/**
 * Make the driver's channel: the office decides the name and who is in it (the wizard on
 * the Dispatch page), so nothing here runs on its own when a driver first texts in.
 * Public channel, topic set to the number, recent thread recapped. Returns the updated
 * conversation.
 */
export async function createSlackChannel(deps: SlackBridgeDeps, conversation: DispatchConversation, input: CreateChannelInput): Promise<DispatchConversation> {
  if (conversation.slackChannelId) return conversation
  const { slack, store } = deps
  const want = cleanChannelName(input.name ?? '') || slackChannelNameFor(conversation)
  let channelId: string
  let name = want
  try {
    const r = await slack.call<{ channel: { id: string; name: string } }>('conversations.create', { name: want, is_private: false })
    channelId = r.channel.id
    name = r.channel.name
  } catch (err) {
    if (!(err instanceof SlackError) || err.code !== 'name_taken') throw err
    // Channel exists from an earlier life (or an archived one): find it and join.
    const found = await findChannelByName(slack, want)
    if (!found) throw err
    channelId = found.id
    if (found.is_archived) await slack.call('conversations.unarchive', { channel: channelId }).catch(() => undefined)
    await slack.call('conversations.join', { channel: channelId }).catch(() => undefined)
  }
  await slack.call('conversations.setTopic', { channel: channelId, topic: channelTopic(conversation) }).catch(() => undefined)
  await inviteStaff(slack, channelId, input.inviteEmails)
  const recap = recapText(conversation, input.recap ?? [])
  if (recap) await slack.call('chat.postMessage', { channel: channelId, text: recap }).catch(() => undefined)
  return store.updateConversation(conversation.id, { set: { slackChannelId: channelId, slackChannelName: name } })
}

function channelTopic(c: DispatchConversation): string {
  return `${conversationTitle(c)} · ${prettyPhone(c.phone)} · texts here go to the driver; start with // for an internal note`
}

export const RECAP_LIMIT = 25

/** The recent thread as one Slack message, so a channel made after a few texts has context. */
export function recapText(conversation: DispatchConversation, messages: readonly DispatchMessage[]): string | null {
  const recent = messages.slice(-RECAP_LIMIT)
  const lines = recent.map((m) => {
    const when = new Date(m.at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const who = m.direction === 'IN' ? conversationTitle(conversation) : (m.sentBy ? staffNameFromEmail(m.sentBy) : 'BCAT Ops')
    const what = m.direction === 'IN' ? formatInbound(m).replace(/\n.*$/s, '') : formatOutbound(m, who).replace(/^💬 \*[^*]*\* \(BCAT Ops\): /, '').replace(/^📝 \*[^*]*\* \(note, not texted\): /, '📝 (note) ')
    return `• ${when} — *${who}*: ${what}`
  })
  if (lines.length === 0) return `Channel linked to ${conversationTitle(conversation)} (${prettyPhone(conversation.phone)}). Texts typed here go to the driver; start a message with // to keep it as an internal note.`
  const more = messages.length > RECAP_LIMIT ? `\n_(${messages.length - RECAP_LIMIT} earlier messages are on the Dispatch page)_` : ''
  return `Channel linked to ${conversationTitle(conversation)} (${prettyPhone(conversation.phone)}). Texts typed here go to the driver; start a message with // to keep it as an internal note.\n\n*Recent thread*\n${lines.join('\n')}${more}`
}

export function staffNameFromEmail(email: string): string {
  const local = email.replace(/^slack:/, '').split('@')[0] || email
  return local.charAt(0).toUpperCase() + local.slice(1)
}

async function findChannelByName(slack: SlackClient, name: string): Promise<{ id: string; is_archived?: boolean } | null> {
  let cursor: string | undefined
  do {
    const page = await slack.call<{ channels: Array<{ id: string; name: string; is_archived?: boolean }>; response_metadata?: { next_cursor?: string } }>(
      'conversations.list', { types: 'public_channel', exclude_archived: false, limit: 1000, cursor },
    )
    const hit = page.channels.find((c) => c.name === name)
    if (hit) return hit
    cursor = page.response_metadata?.next_cursor || undefined
  } while (cursor)
  return null
}

/** Invite the configured staff by email; a missing or already-present member is not an error. */
export async function inviteStaff(slack: SlackClient, channelId: string, emails: readonly string[]): Promise<void> {
  const ids: string[] = []
  for (const email of emails) {
    try {
      const r = await slack.call<{ user: { id: string } }>('users.lookupByEmail', { email })
      ids.push(r.user.id)
    } catch (err) {
      console.warn('[slack-dispatch] no Slack user for', email, String(err))
    }
  }
  if (ids.length === 0) return
  try {
    await slack.call('conversations.invite', { channel: channelId, users: ids.join(',') })
  } catch (err) {
    if (err instanceof SlackError && (err.code === 'already_in_channel' || err.code === 'cant_invite_self')) return
    console.warn('[slack-dispatch] invite failed', String(err))
  }
}

/** Rename after a relink so the channel keeps matching the driver. Best effort. */
export async function renameSlackChannel(deps: SlackBridgeDeps, conversation: DispatchConversation): Promise<DispatchConversation> {
  if (!conversation.slackChannelId) return conversation
  const want = slackChannelNameFor(conversation)
  if (conversation.slackChannelName === want) return conversation
  try {
    const r = await deps.slack.call<{ channel: { name: string } }>('conversations.rename', { channel: conversation.slackChannelId, name: want })
    await deps.slack.call('conversations.setTopic', { channel: conversation.slackChannelId, topic: channelTopic(conversation) }).catch(() => undefined)
    return deps.store.updateConversation(conversation.id, { set: { slackChannelName: r.channel.name } })
  } catch (err) {
    console.warn('[slack-dispatch] rename failed', String(err))
    return conversation
  }
}

// ── Mirroring ───────────────────────────────────────────────────────────────

export interface MediaFetcher { (key: string): Promise<{ bytes: Uint8Array; contentType: string }> }

/** Post what the driver sent into their channel (once it has one), pictures and voicemail audio included. */
export async function mirrorInbound(deps: SlackBridgeDeps, conversation: DispatchConversation, message: DispatchMessage, readMedia: MediaFetcher): Promise<string | null> {
  const channel = conversation.slackChannelId
  if (!channel) return null
  const posted = await deps.slack.call<{ ts: string }>('chat.postMessage', { channel, text: formatInbound(message) })
  const files = [...(message.media ?? []).map((m) => ({ key: m.key, name: m.key.split('/').pop() ?? 'file' })), ...(message.recordingKey ? [{ key: message.recordingKey, name: 'voicemail.mp3' }] : [])]
  for (const f of files) {
    try {
      const got = await readMedia(f.key)
      await deps.slack.upload({ channel, filename: f.name, bytes: got.bytes, title: f.name, threadTs: undefined })
    } catch (err) {
      console.warn('[slack-dispatch] upload failed', f.key, String(err))
    }
  }
  await deps.store.updateMessage(message.id, { slackTs: posted.ts }).catch(() => undefined)
  return posted.ts
}

/** Mirror something staff sent from the page, attachments included (never for messages that came from Slack). */
export async function mirrorOutbound(deps: SlackBridgeDeps, conversation: DispatchConversation, message: DispatchMessage, senderName: string, readMedia?: MediaFetcher): Promise<string | null> {
  if (message.via === 'slack' || !conversation.slackChannelId) return null
  const channel = conversation.slackChannelId
  const posted = await deps.slack.call<{ ts: string }>('chat.postMessage', { channel, text: formatOutbound(message, senderName) })
  for (const m of message.media ?? []) {
    if (!readMedia) break
    try {
      const got = await readMedia(m.key)
      const name = m.key.split('/').pop() ?? 'file'
      await deps.slack.upload({ channel, filename: name, bytes: got.bytes, title: name })
    } catch (err) {
      console.warn('[slack-dispatch] outbound upload failed', m.key, String(err))
    }
  }
  await deps.store.updateMessage(message.id, { slackTs: posted.ts }).catch(() => undefined)
  return posted.ts
}

/** Tell the channel a text bounced, threaded under the message when it came from Slack. */
export async function mirrorDeliveryFailure(deps: SlackBridgeDeps, conversation: DispatchConversation, message: DispatchMessage): Promise<void> {
  if (!conversation.slackChannelId) return
  await deps.slack.call('chat.postMessage', { channel: conversation.slackChannelId, text: formatDeliveryFailure(message), ...(message.slackTs ? { thread_ts: message.slackTs } : {}) })
}

/** Transcript arrived after the voicemail was posted: reply in the channel. */
export async function mirrorTranscript(deps: SlackBridgeDeps, conversation: DispatchConversation, message: DispatchMessage): Promise<void> {
  if (!conversation.slackChannelId || !message.transcript) return
  await deps.slack.call('chat.postMessage', { channel: conversation.slackChannelId, text: `🎙️ Voicemail transcript: _${message.transcript}_`, ...(message.slackTs ? { thread_ts: message.slackTs } : {}) })
}
