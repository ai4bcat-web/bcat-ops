/**
 * Reply in a tender's own Slack thread once its load exists, and move the item to BUILT.
 *
 * WHY
 * Someone reads a tender in Slack, builds the load by hand, replies "PRO# 14589 - Added in
 * BCAT Ops", and never returns to the app. 317 of 1,383 intake items were sitting in NEW
 * describing loads that already existed. The queue reported a day of outstanding work that
 * was mostly finished, so nobody trusted it, so nobody updated it.
 *
 * THE ONE HARD RULE: THIS NEVER STARTS A THREAD.
 * Every post carries the intake item's own `slackMessageTs` as `thread_ts`. An item with no
 * thread is skipped outright — not posted to the channel, not posted anywhere. BCAT Ops
 * must never add a top-level message to a human channel, and `postThreadReply` refuses to
 * send without a thread_ts rather than trusting its callers to remember.
 *
 * Three further guards, because this writes to a shared channel unattended:
 *   - LABELLED matches only. An unlabelled number can collide with an unrelated load by
 *     chance, and a confident wrong reply in front of the team is worse than silence.
 *   - `slackRepliedAt` is the idempotency key, set the moment the post succeeds. A retried
 *     or double-scheduled run must not say the same thing twice.
 *   - A per-run cap, because chat.postMessage is one message per second per channel and a
 *     backlog of 317 cannot go out in one pass anyway.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { buildLoadIndex, matchIntakeToLoad, slackBuiltReply } from '../../../src/lib/intakeMatch'
import type { Load } from '../../../src/types'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const INTAKE_TABLE = process.env.INTAKE_TABLE_NAME ?? ''
const LOAD_TABLE = process.env.LOAD_TABLE_NAME ?? ''

/** Slack allows roughly one post per second per channel; stay well inside it. */
const MAX_REPLIES_PER_RUN = 40
const POST_INTERVAL_MS = 1200

/**
 * conversations.replies is a Tier 3 method (~50/min). The oldest summary is refreshed
 * first, so every thread comes round rather than the newest ones hogging every run.
 */
const MAX_THREAD_READS_PER_RUN = 60
const READ_INTERVAL_MS = 250

/** How far back to look. Anything older is history nobody is chasing. */
const LOOKBACK_DAYS = 45

/** Statuses worth reconciling. Someone who archived an item has already decided. */
const OPEN_STATUSES = new Set(['NEW', 'NEED_TO_BUILD', 'IN_PROGRESS'])

interface IntakeRow {
  id: string
  status?: string | null
  subject?: string | null
  bodyText?: string | null
  receivedAt?: string | null
  slackChannelId?: string | null
  slackMessageTs?: string | null
  slackRepliedAt?: string | null
  proNumber?: string | null
  threadSyncedAt?: string | null
}

export interface ThreadSummary {
  lastReplyText: string
  lastReplyAt: string
  lastReplyUser: string
  replyCount: number
}

/**
 * The last thing said in a thread.
 *
 * The PARENT message is not a reply — it is the tender itself, which the queue already
 * shows — so a thread nobody has answered reports zero replies and no text rather than
 * echoing the subject back.
 */
export function summarizeThread(messages: Array<{ text?: string; ts?: string; user?: string }>): ThreadSummary | null {
  if (!messages.length) return null
  const replies = messages.slice(1)
  if (!replies.length) return { lastReplyText: '', lastReplyAt: '', lastReplyUser: '', replyCount: 0 }
  const last = replies[replies.length - 1]
  return {
    // Slack wraps mentions and links in angle brackets; leave them, the UI renders plain
    // text and a half-parsed mention is more confusing than the raw form.
    lastReplyText: (last.text ?? '').trim().slice(0, 500),
    lastReplyAt: last.ts ?? '',
    lastReplyUser: last.user ?? '',
    replyCount: replies.length,
  }
}

export async function readThread(
  channel: string,
  threadTs: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadSummary | null> {
  if (!channel.trim() || !threadTs.trim() || !SLACK_BOT_TOKEN) return null
  const url = `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=100`
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } })
    const json = (await res.json()) as { ok?: boolean; messages?: Array<{ text?: string; ts?: string; user?: string }> }
    if (!json.ok) return null
    return summarizeThread(json.messages ?? [])
  } catch {
    // A Slack outage must not fail the reconcile pass that follows it.
    return null
  }
}

/** Threads to refresh this run: oldest summary first, so coverage rotates. */
export function selectThreadsToSync(items: IntakeRow[], now: Date): IntakeRow[] {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()
  return items
    .filter((i) => !!i.slackChannelId && !!i.slackMessageTs)
    .filter((i) => (i.receivedAt ?? '') >= cutoff)
    .sort((a, b) => String(a.threadSyncedAt ?? '').localeCompare(String(b.threadSyncedAt ?? '')))
    .slice(0, MAX_THREAD_READS_PER_RUN)
}

async function scanAll<T>(table: string): Promise<T[]> {
  const out: T[] = []
  let key: Record<string, unknown> | undefined
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key }))
    out.push(...((page.Items ?? []) as T[]))
    key = page.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (key)
  return out
}

/**
 * Post into an existing thread. Refuses to send without one.
 *
 * The refusal is the point. A missing thread_ts would make chat.postMessage put a new
 * top-level message in the channel, which is the one thing this job must never do.
 */
export async function postThreadReply(
  channel: string,
  threadTs: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  if (!channel.trim() || !threadTs.trim()) {
    return { ok: false, error: 'refusing to post without an existing thread' }
  }
  if (!SLACK_BOT_TOKEN) return { ok: false, error: 'slack token not configured' }

  const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      text,
      // Keep it in the thread. Never mirrored into the channel.
      reply_broadcast: false,
    }),
  })
  const json = (await res.json()) as { ok: boolean; error?: string }
  return { ok: json.ok === true, error: json.error }
}

/** Items this run may act on, newest first. Pure, so the choice is testable. */
export function selectReconcilable(items: IntakeRow[], now: Date): IntakeRow[] {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()
  return items
    .filter((i) => OPEN_STATUSES.has(String(i.status ?? '')))
    .filter((i) => !i.slackRepliedAt)                       // never say it twice
    .filter((i) => !!i.slackChannelId && !!i.slackMessageTs) // must already have a thread
    .filter((i) => (i.receivedAt ?? '') >= cutoff)
    .sort((a, b) => String(b.receivedAt ?? '').localeCompare(String(a.receivedAt ?? '')))
}

export const handler = async (): Promise<{ examined: number; replied: number; skipped: number; synced: number }> => {
  if (!INTAKE_TABLE || !LOAD_TABLE) {
    console.warn('[intake-reconcile] tables not configured — nothing to do')
    return { examined: 0, replied: 0, skipped: 0, synced: 0 }
  }

  const [items, loads] = await Promise.all([
    scanAll<IntakeRow>(INTAKE_TABLE),
    scanAll<Load>(LOAD_TABLE),
  ])
  const index = buildLoadIndex(loads)

  /*
   * Pass one: cache what each thread currently says, so the queue can show the
   * conversation it has never been able to see. Read-only, and done first — the reply
   * below adds a message, and a summary taken afterwards would show our own words as the
   * latest thing anybody said.
   */
  let synced = 0
  for (const item of selectThreadsToSync(items, new Date())) {
    const summary = await readThread(String(item.slackChannelId), String(item.slackMessageTs))
    if (!summary) continue
    await ddb.send(new UpdateCommand({
      TableName: INTAKE_TABLE,
      Key: { id: item.id },
      UpdateExpression:
        'SET lastReplyText = :t, lastReplyAt = :at, lastReplyUser = :u, replyCount = :n, threadSyncedAt = :s',
      ExpressionAttributeValues: {
        ':t': summary.lastReplyText,
        ':at': summary.lastReplyAt,
        ':u': summary.lastReplyUser,
        ':n': summary.replyCount,
        ':s': new Date().toISOString(),
      },
    }))
    synced += 1
    await new Promise((r) => setTimeout(r, READ_INTERVAL_MS))
  }

  const candidates = selectReconcilable(items, new Date())

  let replied = 0
  let skipped = 0

  for (const item of candidates) {
    if (replied >= MAX_REPLIES_PER_RUN) break

    const match = matchIntakeToLoad(`${item.subject ?? ''} ${item.bodyText ?? ''}`, index)
    // Only a number the tender labels. An unlabelled hit is left for a person.
    if (!match || match.confidence !== 'LABELLED') { skipped += 1; continue }

    const result = await postThreadReply(
      String(item.slackChannelId),
      String(item.slackMessageTs),
      slackBuiltReply(match.pro),
    )
    if (!result.ok) {
      console.error('[intake-reconcile] reply failed', { id: item.id, error: result.error })
      skipped += 1
      continue
    }

    /*
     * Recorded straight after the post, before anything else can fail. If this write is
     * lost the next run would repeat the reply, so it is the first thing done with a
     * successful send.
     */
    await ddb.send(new UpdateCommand({
      TableName: INTAKE_TABLE,
      Key: { id: item.id },
      UpdateExpression: 'SET slackRepliedAt = :at, #s = :status, proNumber = :pro, builtLoadId = :load',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':at': new Date().toISOString(),
        ':status': 'BUILT',
        ':pro': match.pro,
        ':load': match.load.id,
      },
    }))
    replied += 1
    console.log('[intake-reconcile] replied in thread', {
      id: item.id, pro: match.pro, matchedOn: match.matchedOn, loadId: match.load.id,
    })

    await new Promise((r) => setTimeout(r, POST_INTERVAL_MS))
  }

  console.log('[intake-reconcile] done', { examined: candidates.length, replied, skipped, synced })
  return { examined: candidates.length, replied, skipped, synced }
}
