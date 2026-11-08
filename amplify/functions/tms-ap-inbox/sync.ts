/**
 * Step AG §5.3 — one run of the AP inbox review: the hourly schedule door, the budgeted
 * "Review now" slices and the catch-up after a partial run all come through `runSync`.
 *
 *   schedule gate -> refusals -> run lock -> ledger -> list (cursor) -> metadata -> workers -> cursor
 *
 * The cursor is a timestamp, never mailbox state: it only moves over the contiguous prefix of
 * settled messages (processed, rejected, or parked on the retry list), so a capped / timed-out run
 * leaves the newer mail for the next slice and one bad PDF never blocks the mailbox.
 */
import { randomUUID } from 'node:crypto'
import { MAX_BOUNDARY_IDS, MAX_LOOKBACK_MS, MAX_RETRIES, MAX_RETRY_KEPT, MAX_RUNS_KEPT, RUN_STALE_MS } from '../../../src/lib/apInbox/constants'
import { agentEnabled } from '../../../src/lib/workflows/memory'
import type { AiAgentsSettings } from '../../../src/types/tms'
import type { GmailMessageMeta } from '../../../src/lib/spot/port'
import type { ApInboxConfig, ApInboxState, ApRunDigest } from '../../../src/lib/apInbox/types'
import { NeedsReconnect } from '../_shared/gmail/errors'
import type { ApInboxDeps } from './contract'
import { createSerial, newCounters, processMessage, type Counters, type PipelineContext } from './pipeline'

export const WORKERS = 4
export const METADATA_CONCURRENCY = 6
export const SCHEDULED_BUDGET_MS = 270_000

export interface SyncOptions {
  trigger: ApRunDigest['trigger']
  budgetMs: number
}

export interface SyncResult {
  /** Why nothing ran: DISABLED | NOT_DUE | RUNNING. */
  skipped?: string
  /** False while the cursor is behind: the caller (the UI loop, the hourly catch-up) comes back. */
  done: boolean
  reviewed: number
  remaining: number
  digest: ApRunDigest | null
}

/** The Chicago calendar day (`YYYY-MM-DD`) and hour (0-23) of an instant. DST-proof (Intl). */
export function chicagoParts(at: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

/** The hourly door runs the review once a day at the configured Chicago hour, or to finish a partial run. */
export function scheduleDue(now: Date, config: Pick<ApInboxConfig, 'runHourChicago'>, state: Pick<ApInboxState, 'runs' | 'lastScheduledDay'>): boolean {
  const last = state.runs[0]
  if (last?.partial === true && !last.error) return true
  const { day, hour } = chicagoParts(now)
  return hour >= config.runHourChicago && state.lastScheduledDay !== day
}

const COUNT_KEYS = [
  'listed', 'reviewed', 'stage1Rejected', 'stage2Rejected', 'modelCalls', 'notInvoice', 'invoices',
  'applied', 'updatedBills', 'needReview', 'errors', 'abandoned',
] as const satisfies readonly (keyof Counters)[]

function refusalOf(deps: ApInboxDeps, config: ApInboxConfig, state: ApInboxState, aiAgents: unknown): ApRunDigest['error'] | null {
  if (!config.enabled) return 'NOT_CONFIGURED'
  if (config.mode === 'SIMULATED') {
    if (!deps.devStack) return 'NOT_CONFIGURED'
  } else if (state.connection.status === 'NEEDS_RECONNECT') {
    return 'NEEDS_RECONNECT'
  } else if (state.connection.status !== 'CONNECTED') {
    return 'NOT_CONFIGURED'
  }
  if (!agentEnabled(aiAgents as AiAgentsSettings | null, 'AP')) return 'AGENT_DISABLED'
  return null
}

function blankDigest(id: string, trigger: ApRunDigest['trigger'], startedAt: string): ApRunDigest {
  return { id, trigger, startedAt, endedAt: startedAt, ...newCounters(), partial: false }
}

/** A continuing slice folds into the digest of the run it continues, so "reviewed N" is the whole run. */
function foldDigest(prev: ApRunDigest | undefined, next: ApRunDigest): ApRunDigest {
  if (!prev || !prev.partial || prev.error || (next.error && next.error !== 'MODEL_CAP')) return next
  const merged: ApRunDigest = { ...next, id: prev.id, trigger: prev.trigger, startedAt: prev.startedAt }
  for (const key of COUNT_KEYS) merged[key] = prev[key] + next[key]
  merged.listed = prev.listed + next.listed
  return merged
}

function pushDigest(runs: ApRunDigest[], digest: ApRunDigest): ApRunDigest[] {
  const head = runs[0]
  const rest = head && (head.id === digest.id || (head.error && head.error === digest.error)) ? runs.slice(1) : runs
  return [digest, ...rest].slice(0, MAX_RUNS_KEPT)
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface Work {
  id: string
  /** Retry entries do not move the cursor. */
  retry: boolean
  meta: GmailMessageMeta | null
  settled: boolean
}

export async function runSync(deps: ApInboxDeps, o: SyncOptions): Promise<SyncResult> {
  const now = deps.now()
  const startedAtMs = Date.now()
  const deadline = startedAtMs + o.budgetMs
  const [config, state, aiAgents] = await Promise.all([deps.store.getConfig(), deps.store.getState(), deps.store.getAiAgents()])
  const result = (digest: ApRunDigest | null, extra: Partial<SyncResult> = {}): SyncResult => ({
    done: digest ? !digest.partial || digest.error === 'MODEL_CAP' : true,
    reviewed: digest?.reviewed ?? 0,
    remaining: 0,
    digest,
    ...extra,
  })

  const scheduled = o.trigger === 'SCHEDULE'
  if (scheduled && !scheduleDue(now, config, state)) return result(null, { skipped: 'NOT_DUE' })
  if (scheduled && !config.enabled) return result(null, { skipped: 'DISABLED' })

  const today = chicagoParts(now).day
  const refusal = refusalOf(deps, config, state, aiAgents)
  if (refusal) {
    const digest = { ...blankDigest(randomUUID(), o.trigger, now.toISOString()), error: refusal }
    await deps.store.patchState({
      runs: pushDigest(state.runs, digest),
      ...(scheduled ? { lastScheduledDay: today } : {}),
    })
    return result(digest)
  }

  if (!(await deps.store.claimRun(now, new Date(now.getTime() - RUN_STALE_MS)))) {
    return result(null, { skipped: 'RUNNING', done: true })
  }

  const continuing = state.runs[0]?.partial === true && !state.runs[0].error ? state.runs[0] : undefined
  const runId = continuing?.id ?? randomUUID()
  const counters = newCounters()
  let error: string | undefined
  let connection = state.connection
  let cursor = state.cursor
  let retry = state.retry
  let gapNote: string | undefined
  let unsettled = 0
  let moreInMailbox = false

  try {
    const mailbox = deps.mailboxFor(config.mode)
    const ledger = await deps.store.loadLedger()
    const blacklist = await deps.store.getBlacklist()
    const ctx: PipelineContext = {
      deps,
      config,
      mailbox,
      ledger,
      runId,
      counters,
      ignoreSenders: [...new Set([...config.ignoreSenders, ...blacklist.addresses.map((a) => a.toLowerCase())])],
      ignoreKeywords: blacklist.keywords.map((k) => k.toLowerCase()),
      serial: createSerial(),
    }

    const floor = now.getTime() - MAX_LOOKBACK_MS
    let afterMs = cursor?.afterMs ?? now.getTime() - config.lookbackHours * 3_600_000
    if (afterMs < floor) {
      const days = Math.ceil((now.getTime() - afterMs) / 86_400_000)
      gapNote = `mailbox was not read for ${days} days; looked back 7`
      afterMs = floor
    }
    const boundary = new Set(cursor?.boundaryIds ?? [])
    const listed = await mailbox.listAfter({ afterMs, max: config.maxMessagesPerRun })
    moreInMailbox = listed.length >= config.maxMessagesPerRun
    const fresh = [...new Set(listed)].filter((id) => !boundary.has(id))
    const retryIds = retry.map((r) => r.id)
    counters.listed = fresh.length

    const work: Work[] = [
      ...retryIds.map((id) => ({ id, retry: true, meta: null, settled: false })),
      ...fresh.filter((id) => !retryIds.includes(id)).map((id) => ({ id, retry: false, meta: null, settled: false })),
    ]
    const failed = new Map<string, string>()
    await mapLimit(work, METADATA_CONCURRENCY, async (w) => {
      try {
        w.meta = await mailbox.getMetadata(w.id)
      } catch (err) {
        if (err instanceof NeedsReconnect) throw err
        failed.set(w.id, err instanceof Error ? err.name : 'error')
      }
    })
    const ordered = [
      ...work.filter((w) => w.retry),
      ...work.filter((w) => !w.retry).sort((a, b) => Number(a.meta?.internalDate ?? Infinity) - Number(b.meta?.internalDate ?? Infinity)),
    ]

    const nextRetry = new Map<string, { id: string; tries: number; lastAt: string; code: string }>()
    const park = (id: string, code: string): void => {
      const tries = (retry.find((r) => r.id === id)?.tries ?? 0) + 1
      if (tries >= MAX_RETRIES) counters.abandoned += 1
      else nextRetry.set(id, { id, tries, lastAt: now.toISOString(), code })
    }

    let cursorIdx = 0
    let stop = false
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop || Date.now() >= deadline) return
        const w = ordered[cursorIdx++]
        if (!w) return
        if (!w.meta) {
          park(w.id, failed.get(w.id) ?? 'error')
          counters.errors += 1
          w.settled = true
          continue
        }
        try {
          const outcome = await processMessage(ctx, w.meta)
          if (outcome === 'MODEL_CAP') {
            stop = true
            error = 'MODEL_CAP'
            return
          }
          if (outcome !== 'EXISTS') counters.reviewed += 1
          w.settled = true
        } catch (err) {
          if (err instanceof NeedsReconnect) {
            stop = true
            error = 'NEEDS_RECONNECT'
            return
          }
          counters.errors += 1
          park(w.id, err instanceof Error ? err.name.slice(0, 40) : 'error')
          w.settled = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, ordered.length) }, worker))

    unsettled = ordered.filter((w) => !w.settled).length
    if (error === 'NEEDS_RECONNECT') {
      connection = { ...connection, status: 'NEEDS_RECONNECT', lastError: 'Google no longer accepts the connection; reconnect the mailbox.' }
    } else {
      // Retried ones that got through leave the list; parked ones stay (tries + 1).
      retry = [...nextRetry.values(), ...retry.filter((r) => !work.some((w) => w.id === r.id && w.retry) && !nextRetry.has(r.id))].slice(0, MAX_RETRY_KEPT)
      const freshOrdered = ordered.filter((w) => !w.retry && w.meta)
      let last = -1
      while (last + 1 < freshOrdered.length && freshOrdered[last + 1].settled) last += 1
      if (last >= 0) {
        const date = Number(freshOrdered[last].meta?.internalDate)
        const ids = freshOrdered.slice(0, last + 1).filter((w) => Number(w.meta?.internalDate) === date).map((w) => w.id)
        const keep = cursor?.afterMs === date ? [...(cursor.boundaryIds ?? []), ...ids] : ids
        cursor = { afterMs: date, boundaryIds: [...new Set(keep)].slice(-MAX_BOUNDARY_IDS) }
      } else if (!cursor && fresh.length === 0) {
        cursor = { afterMs, boundaryIds: [] }
      }
    }
  } catch (err) {
    if (err instanceof NeedsReconnect) {
      error = 'NEEDS_RECONNECT'
      connection = { ...connection, status: 'NEEDS_RECONNECT', lastError: 'Google no longer accepts the connection; reconnect the mailbox.' }
    } else {
      error = 'RUN_FAILED'
      console.warn('[tms-ap-inbox] run failed:', err instanceof Error ? err.name : 'error')
    }
  }

  const reconnect = error === 'NEEDS_RECONNECT'
  const partial = !reconnect && error !== 'RUN_FAILED' && (unsettled > 0 || (moreInMailbox && counters.listed > 0))
  const endedAt = new Date().toISOString()
  const digest = foldDigest(continuing, {
    ...blankDigest(runId, o.trigger, now.toISOString()),
    ...counters,
    endedAt,
    partial,
    ...(error ? { error } : {}),
  })
  try {
    await deps.store.patchState({
      connection,
      cursor,
      retry,
      gapNote,
      runs: pushDigest(state.runs, digest),
      ...(scheduled && !partial && error !== 'RUN_FAILED' ? { lastScheduledDay: today } : {}),
    })
  } finally {
    await deps.store.releaseRun()
  }
  return result(digest, { remaining: unsettled })
}
