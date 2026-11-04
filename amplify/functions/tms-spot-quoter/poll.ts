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
import { reconcileDrafts } from './reconcile'

export const MAX_HELD_RUNS = 3
export const POLL_STALE_MS = 4 * 60_000
export const MIN_REMAINING_MS = 25_000
export const DEFAULT_BUDGET_MS = 270_000

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

    for (const id of ids.slice(0, max)) {
      if (deps.now().getTime() > shared.deadline) {
        hold = hold ?? 'DEFER'
        break
      }
      try {
        const outcome = await processMessage(ctx, id)
        if (outcome === 'MODEL_CAP') hold = hold ?? 'DEFER'
      } catch (err) {
        if (err instanceof NeedsReconnect) throw err
        stats.errors += 1
        hold = 'ERROR'
        console.warn('[tms-spot-quoter] one message failed:', redact(err))
      }
    }

    const priorHeld = (conn.lastPollStats as PollStats | null | undefined)?.held ?? 0
    if (hold === 'ERROR' && priorHeld < MAX_HELD_RUNS) {
      stats.held = priorHeld + 1
    } else if (hold === 'DEFER') {
      stats.held = priorHeld
    } else if (nextHistory) {
      patch.historyId = nextHistory
    }

    await reconcileDrafts(deps, conn, port).catch((err: unknown) => console.warn('[tms-spot-quoter] reconcile failed:', redact(err)))
    patch.lastPollOk = stats.errors === 0
    patch.lastError = null
  } catch (err) {
    patch.lastPollOk = false
    if (err instanceof NeedsReconnect) {
      patch.status = 'NEEDS_RECONNECT'
      patch.lastError = 'Google no longer accepts this connection. Reconnect Gmail.'
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

export async function pollAll(deps: SpotDeps, scope: PollScope = {}, budgetMs = DEFAULT_BUDGET_MS): Promise<PollAllResult> {
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
    if (shared.deadline - deps.now().getTime() < MIN_REMAINING_MS) {
      skipped += connections.length - polled - skipped
      break
    }
    const stats = await pollConnection(deps, conn, shared)
    if (!stats) {
      skipped += 1
      continue
    }
    polled += 1
    for (const key of ['listed', 'stage1Rejected', 'stage2Rejected', 'modelCalls', 'stored', 'attached', 'errors'] as const) {
      total[key] += stats[key]
    }
  }
  return { stats: total, polled, skipped }
}
