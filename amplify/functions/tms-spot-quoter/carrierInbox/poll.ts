/**
 * Step AL — the carrier-inbox polling loop (plan §5.2). The same shape as the spot
 * `pollConnection`: one mailbox at a time, least-recently-polled first, the history cursor
 * advanced only past a fully settled batch.
 *
 * Messages are classified with a few workers but handed to the router by ONE in-order filer
 * (oldest first): `recordCarrierOffer` takes a CAS on the shipment, so two offers for one
 * load must never file concurrently. A message that errors (Gmail, model timeout, router)
 * is not stored and holds the cursor for at most MAX_HELD_RUNS runs, then is abandoned and
 * counted. A revoked grant flips the mailbox to NEEDS_RECONNECT and stops the run.
 */
import { resolveCarrierInboxConfig } from '../../../../src/lib/carrierInbox/settings'
import type {
  CarrierInboxMailbox,
  CarrierInboxMailboxState,
  CarrierInboxRunDigest,
  CarrierInboxRunStats,
  ResolvedCarrierInboxConfig,
} from '../../../../src/lib/carrierInbox/types'
import { NeedsReconnect } from '../../_shared/gmail/errors'
import { MAX_HELD_RUNS, POLL_STALE_MS } from '../poll'
import type { CarrierInboxDeps } from './deps'
import {
  budgetOf,
  emptyCsStats,
  fileMailboxMessage,
  modelGate,
  prepareMailboxMessage,
  type CsBudget,
  type CsMailContext,
  type CsMailOutcome,
  type PreparedMail,
} from './pipeline'
import { emptyMailboxState } from './store'

/** Classifications in flight per mailbox; filing stays serial. */
export const CS_CLASSIFY_CONCURRENCY = 4
export const CS_SCHEDULE_BUDGET_MS = 90_000
/** A mailbox is not started with less than this left. */
export const CS_MIN_REMAINING_MS = 8_000

export interface CarrierPollOptions {
  trigger: 'SCHEDULE' | 'MANUAL'
  budgetMs: number
  mailboxId?: string
}

export interface CarrierPollResult {
  elapsedMs: number
  stats: CarrierInboxRunStats
  polled: number
  skipped: number
  /** True when nothing is left to read right now (the UI's "Review now" loop stops here). */
  done: boolean
  /** Messages known to still wait behind the cursor after this slice. */
  remaining: number
  reason: string | null
}

function redact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').slice(0, 200)
}

const ADD_KEYS = [
  'listed', 'wrongMailbox', 'stage1Rejected', 'stage2Rejected', 'modelCalls', 'notOffer',
  'filed', 'threadOnly', 'coveredLate', 'suggested', 'unmatched', 'duplicate', 'errors', 'abandoned',
] as const satisfies readonly (keyof CarrierInboxRunStats)[]

interface MailboxRun {
  stats: CarrierInboxRunStats
  /** Messages left in the queue when time ran out (0 when the batch settled). */
  remaining: number
  ran: boolean
}

/** Mailboxes that may be read now: configured, not paused, connected (or simulated). */
export function pollableMailboxes(
  cfg: ResolvedCarrierInboxConfig,
  states: Record<string, CarrierInboxMailboxState>,
  only?: string,
): CarrierInboxMailbox[] {
  return cfg.mailboxes
    .filter((m) => !only || m.id === only)
    .filter((m) => !m.paused)
    .filter((m) => {
      const status = states[m.id]?.status
      return m.mode === 'SIMULATED' ? status === 'SIMULATED' : status === 'CONNECTED'
    })
    .sort((a, b) => String(states[a.id]?.lastPollAt ?? '').localeCompare(String(states[b.id]?.lastPollAt ?? '')))
}

async function pollMailbox(
  deps: CarrierInboxDeps,
  base: Omit<CsMailContext, 'mailbox' | 'port' | 'stats'>,
  mailbox: CarrierInboxMailbox,
  mstate: CarrierInboxMailboxState,
  deadline: number,
): Promise<MailboxRun | null> {
  const startedAt = deps.now().toISOString()
  const claimed = await deps.store.claimMailbox(mailbox.id, startedAt, new Date(deps.now().getTime() - POLL_STALE_MS).toISOString())
  if (!claimed) return null

  const stats = emptyCsStats()
  const port = deps.portFor(mailbox)
  const ctx: CsMailContext = { ...base, mailbox, port, stats }
  const patch: Partial<CarrierInboxMailboxState> = {}
  let hold: 'ERROR' | 'DEFER' | null = null
  let remaining = 0

  try {
    const max = base.cfg.maxMessagesPerRun
    const label = mailbox.gmailLabel
    let ids: string[]
    let nextHistory: string | null
    if (!mstate.historyId) {
      nextHistory = (await port.profile()).historyId
      ids = await port.listRecent({ lookbackDays: Math.max(1, Math.ceil(base.cfg.lookbackHours / 24)), label, max })
    } else {
      const since = await port.listSince(mstate.historyId, { label, max })
      if ('expired' in since) {
        const lastMs = mstate.lastPollAt ? new Date(mstate.lastPollAt).getTime() : deps.now().getTime()
        const days = Math.min(7, Math.max(1, Math.ceil((deps.now().getTime() - lastMs) / 86_400_000)))
        nextHistory = (await port.profile()).historyId
        ids = await port.listRecent({ lookbackDays: days, label, max })
      } else {
        nextHistory = since.historyId
        ids = since.ids
      }
    }
    stats.listed = ids.length
    const queue = ids.slice(0, max)

    // Classify with a few workers, ahead of the filer.
    let fatal: unknown = null
    let running = 0
    let next = 0
    const prepared: Promise<PreparedMail | { error: unknown } | { deferred: true }>[] = []
    const launch = (): void => {
      while (running < CS_CLASSIFY_CONCURRENCY && next < queue.length && !fatal) {
        const index = next
        next += 1
        running += 1
        prepared[index] = (async () => {
          if (deps.now().getTime() > deadline) return { deferred: true as const }
          try {
            return await prepareMailboxMessage(ctx, queue[index])
          } catch (err) {
            return { error: err }
          }
        })().finally(() => {
          running -= 1
          launch()
        })
      }
    }
    launch()

    for (let i = 0; i < queue.length; i += 1) {
      if (!prepared[i]) {
        // Never launched (a fatal error stopped the launcher).
        remaining += queue.length - i
        break
      }
      const item = await prepared[i]
      if ('deferred' in item) {
        remaining += 1
        hold = hold ?? 'DEFER'
        continue
      }
      if ('error' in item) {
        if (item.error instanceof NeedsReconnect) fatal = item.error
        else {
          stats.errors += 1
          hold = 'ERROR'
          console.warn('[carrier-inbox] one message failed:', redact(item.error))
        }
        continue
      }
      if (fatal) continue
      let outcome: CsMailOutcome
      try {
        outcome = await fileMailboxMessage(ctx, item)
      } catch (err) {
        stats.errors += 1
        hold = 'ERROR'
        console.warn('[carrier-inbox] hand-over failed:', redact(err))
        continue
      }
      if (outcome === 'MODEL_OFF' || outcome === 'MODEL_CAP') {
        remaining += 1
        hold = hold === 'ERROR' ? hold : 'DEFER'
      }
    }
    if (fatal) throw fatal

    if (hold === 'ERROR' && mstate.held < MAX_HELD_RUNS) {
      stats.held = mstate.held + 1
      patch.held = stats.held
    } else if (hold === 'DEFER') {
      stats.deferred = 1
      patch.held = mstate.held
    } else {
      // Settled (or the held limit is reached: the message is abandoned and counted).
      if (hold === 'ERROR') stats.abandoned = stats.errors
      patch.held = 0
      if (nextHistory) patch.historyId = nextHistory
    }
    patch.lastPollOk = stats.errors === 0
    patch.lastError = stats.errors > 0
      ? `${stats.errors} message${stats.errors === 1 ? '' : 's'} could not be classified or filed this run; retrying next run. Nothing from them was stored.`
      : null
  } catch (err) {
    patch.lastPollOk = false
    if (err instanceof NeedsReconnect) {
      patch.status = 'NEEDS_RECONNECT'
      patch.lastError = 'Google no longer accepts this connection (a Google app in Testing mode expires access after 7 days). Reconnect the mailbox.'
    } else {
      patch.lastError = redact(err)
      stats.errors += 1
    }
  }

  patch.lastPollAt = deps.now().toISOString()
  patch.lastStats = stats
  patch.runningAt = null
  await deps.store.patchMailboxState(mailbox.id, patch)
  return { stats, remaining, ran: true }
}

/** Why a mailbox is not read right now (model off / cap), or null. The dev stack's simulated mailbox needs no model. */
function modelBlock(deps: CarrierInboxDeps, base: Omit<CsMailContext, 'mailbox' | 'port' | 'stats'>, mailbox: CarrierInboxMailbox): string | null {
  if (deps.devStack && mailbox.mode === 'SIMULATED') return null
  const gate = modelGate(base)
  if (gate === 'OFF') return 'The CAPACITY agent is switched off, so nothing can be classified.'
  if (gate === 'CAP') return 'The daily model-call limit is used; the mail waits for tomorrow.'
  return null
}

export async function pollCarrierInbox(deps: CarrierInboxDeps, opts: CarrierPollOptions): Promise<CarrierPollResult> {
  const started = deps.now().getTime()
  const total = emptyCsStats()
  const finish = (skipped: string | null, polled: number, skippedN: number, done: boolean, remaining: number): CarrierPollResult => ({
    elapsedMs: deps.now().getTime() - started, stats: total, polled, skipped: skippedN, done, remaining, reason: skipped,
  })

  const cfg = resolveCarrierInboxConfig(await deps.store.getConfigRaw())
  const digest = async (reason: string | null, ok: boolean, error: string | null): Promise<void> => {
    const entry: CarrierInboxRunDigest = {
      at: deps.now().toISOString(), trigger: opts.trigger, mailboxId: opts.mailboxId ?? null, ok,
      elapsedMs: deps.now().getTime() - started, skipped: reason, stats: reason ? null : total, error,
    }
    await deps.store.pushRunDigest(entry)
  }

  if (!cfg.enabled) {
    // The schedule runs every five minutes: a switched-off feature leaves no trace.
    if (opts.trigger === 'MANUAL') await digest('DISABLED', true, null)
    return finish('DISABLED', 0, 0, true, 0)
  }

  const state = await deps.store.getState()
  const mailboxes = pollableMailboxes(cfg, state.mailboxes, opts.mailboxId)
  if (!mailboxes.length) return finish('NO_MAILBOX', 0, 0, true, 0)

  const aiAgents = await deps.loadAiAgents()
  const blacklist = await deps.loadBlacklist()
  const budget: CsBudget = budgetOf(state, deps.now())
  const startCount = budget.count
  const base = { deps, cfg, aiAgents, blacklist, budget }
  const deadline = started + opts.budgetMs

  let polled = 0
  let skipped = 0
  let remaining = 0
  let reason: string | null = null
  let failure: string | null = null
  try {
    for (const mailbox of mailboxes) {
      if (deadline - deps.now().getTime() < CS_MIN_REMAINING_MS && polled > 0) {
        skipped += 1
        remaining += 1
        continue
      }
      const blocked = modelBlock(deps, base, mailbox)
      if (blocked) {
        skipped += 1
        reason = reason ?? (blocked.includes('limit') ? 'MODEL_CAP' : 'MODEL_OFF')
        total.deferred = 1
        await deps.store.patchMailboxState(mailbox.id, { lastError: blocked })
        continue
      }
      const run = await pollMailbox(deps, base, mailbox, state.mailboxes[mailbox.id] ?? emptyMailboxState(), deadline)
      if (!run) {
        skipped += 1
        continue
      }
      polled += 1
      remaining += run.remaining
      for (const key of ADD_KEYS) total[key] += run.stats[key]
      total.held = Math.max(total.held, run.stats.held)
      total.deferred = Math.max(total.deferred, run.stats.deferred)
    }
  } catch (err) {
    failure = redact(err)
  } finally {
    await deps.store.bumpModelCalls(budget.day, budget.count - startCount).catch((err) => {
      console.warn('[carrier-inbox] model-call counter failed:', redact(err))
    })
  }
  await digest(polled === 0 ? reason : null, failure === null && total.errors === 0, failure)
  // A held error is retried by the schedule, not by the UI loop (which would burn the held counter).
  const done = remaining === 0 && total.deferred === 0
  return finish(polled === 0 ? reason : null, polled, skipped, done, remaining)
}
