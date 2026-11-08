/**
 * tms-spot-quoter — the polling loop (plan §3.1).
 *
 * One pass over the CONNECTED connections, least-recently-polled first, stopping when
 * the remaining time is short. A failure on one message is counted and the cursor is
 * held (at most `MAX_HELD_RUNS` consecutive runs, then skipped) so it is retried without
 * ever being stored. A revoked grant flips the connection to NEEDS_RECONNECT and stops.
 */
import type { GmailConnectionRecord } from '../../../src/types/tms'
import { resolveRepSettings, resolveSpotSettings, type ResolvedSpotSettings } from '../../../src/lib/spot/settings'
import type { AiAgentsSettings } from '../../../src/types/tms'
import { NeedsReconnect } from '../_shared/gmail/errors'
import type { SpotDeps } from './deps'
import {
  budgetOf,
  emptyStats,
  loadAiAgents,
  loadBlacklist,
  processMessage,
  type PollContext,
  type PollStats,
} from './pipeline'

export const MAX_HELD_RUNS = 3
export const POLL_STALE_MS = 4 * 60_000
export const MIN_REMAINING_MS = 25_000
export const DEFAULT_BUDGET_MS = 270_000
/** AppSync cuts an action off at 30 s: a manual poll stops itself well before that. */
export const ACTION_BUDGET_MS = 20_000
export const ACTION_MIN_REMAINING_MS = 2_000
/** Messages in flight per connection; model calls dominate and are I/O bound. */
export const POLL_CONCURRENCY = 6

interface Shared {
  settings: ResolvedSpotSettings
  aiAgents: AiAgentsSettings | null
  blacklist: { addresses: string[]; keywords: string[] }
  deadline: number
}

function redact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').slice(0, 200)
}

export async function pollConnection(deps: SpotDeps, conn: GmailConnectionRecord, shared: Shared): Promise<PollStats | null> {
  const startedAt = deps.now().toISOString()
  const claimed = await deps.store.claimPoll(conn.id, startedAt, new Date(deps.now().getTime() - POLL_STALE_MS).toISOString())
  if (!claimed) return null

  const stats = emptyStats()
  const budget = budgetOf(conn, deps.now())
  const port = deps.portFor(conn)
  const ctx: PollContext = {
    deps, conn, port, stats, budget,
    settings: shared.settings,
    aiAgents: shared.aiAgents,
    blacklist: shared.blacklist,
    senderCache: new Map(),
  }
  const repSettings = resolveRepSettings(conn.settings)
  const max = shared.settings.maxMessagesPerRepPerRun
  const patch: Record<string, unknown> = { lastPollStartedAt: null }
  let hold: 'ERROR' | 'DEFER' | null = null

  try {
    let ids: string[]
    let nextHistory: string | null
    if (!conn.historyId) {
      nextHistory = (await port.profile()).historyId
      ids = await port.listRecent({ lookbackDays: repSettings.lookbackDays, label: repSettings.watchLabel, max })
    } else {
      const since = await port.listSince(conn.historyId, { label: repSettings.watchLabel, max })
      if ('expired' in since) {
        // History cursor too old: fall back to the days since the last poll.
        const lastMs = conn.lastPollAt ? new Date(conn.lastPollAt).getTime() : deps.now().getTime()
        const days = Math.min(7, Math.max(1, Math.ceil((deps.now().getTime() - lastMs) / 86_400_000)))
        nextHistory = (await port.profile()).historyId
        ids = await port.listRecent({ lookbackDays: days, label: repSettings.watchLabel, max })
      } else {
        nextHistory = since.historyId
        ids = since.ids
      }
    }
    stats.listed = ids.length

    const queue = ids.slice(0, max)
    let fatal: unknown = null
    const worker = async (): Promise<void> => {
      while (!fatal) {
        if (deps.now().getTime() > shared.deadline) {
          if (queue.length > 0) hold = hold ?? 'DEFER'
          return
        }
        const id = queue.shift()
        if (id === undefined) return
        try {
          const outcome = await processMessage(ctx, id)
          if (outcome === 'MODEL_CAP') hold = hold ?? 'DEFER'
        } catch (err) {
          if (err instanceof NeedsReconnect) {
            fatal = err
            return
          }
          stats.errors += 1
          hold = 'ERROR'
          console.warn('[tms-spot-quoter] one message failed:', redact(err))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, worker))
    if (fatal) throw fatal

    const priorHeld = (conn.lastPollStats as PollStats | null | undefined)?.held ?? 0
    if (hold === 'ERROR' && priorHeld < MAX_HELD_RUNS) {
      stats.held = priorHeld + 1
    } else if (hold === 'DEFER') {
      stats.held = priorHeld
      stats.deferred = 1
    } else if (nextHistory) {
      patch.historyId = nextHistory
    }

    patch.lastPollOk = stats.errors === 0
    // A message that could not be classified is not stored; it is retried while the cursor holds.
    patch.lastError = stats.errors > 0
      ? `${stats.errors} message${stats.errors === 1 ? '' : 's'} could not be classified this run (model or Gmail error); retrying next run. Nothing from them was stored.`
      : null
  } catch (err) {
    patch.lastPollOk = false
    if (err instanceof NeedsReconnect) {
      patch.status = 'NEEDS_RECONNECT'
      patch.lastError = 'Google no longer accepts this connection (a Google app in Testing mode expires access after 7 days). Reconnect Gmail.'
    } else {
      patch.lastError = redact(err)
      stats.errors += 1
    }
  }

  patch.lastPollAt = deps.now().toISOString()
  patch.lastPollStats = stats
  patch.modelCallsDay = budget.day
  patch.modelCallsToday = budget.count
  await deps.store.updateConnection(conn.id, patch)
  return stats
}

export interface PollScope {
  userId?: string
}

export interface PollAllResult {
  stats: PollStats
  polled: number
  skipped: number
  reason?: 'DISABLED'
}

export async function pollAll(
  deps: SpotDeps,
  scope: PollScope = {},
  budgetMs = DEFAULT_BUDGET_MS,
  minRemainingMs = MIN_REMAINING_MS,
): Promise<PollAllResult> {
  const total = emptyStats()
  const settings = resolveSpotSettings(await deps.store.getSpotSettings())
  if (!settings.enabled) return { stats: total, polled: 0, skipped: 0, reason: 'DISABLED' }

  const started = deps.now().getTime()
  const shared: Shared = {
    settings,
    aiAgents: await loadAiAgents(deps),
    blacklist: await loadBlacklist(deps),
    deadline: started + budgetMs,
  }
  const connections = (await deps.store.listConnections())
    .filter((c) => c.status === 'CONNECTED' && (!scope.userId || c.id === scope.userId))
    .sort((a, b) => String(a.lastPollAt ?? '').localeCompare(String(b.lastPollAt ?? '')))

  let polled = 0
  let skipped = 0
  for (const conn of connections) {
    if (shared.deadline - deps.now().getTime() < minRemainingMs) {
      skipped += connections.length - polled - skipped
      break
    }
    const stats = await pollConnection(deps, conn, shared)
    if (!stats) {
      skipped += 1
      continue
    }
    polled += 1
    if (stats.deferred) total.deferred = 1
    for (const key of ['listed', 'stage1Rejected', 'stage2Rejected', 'modelCalls', 'stored', 'attached', 'errors'] as const) {
      total[key] += stats[key]
    }
  }
  return { stats: total, polled, skipped }
}
