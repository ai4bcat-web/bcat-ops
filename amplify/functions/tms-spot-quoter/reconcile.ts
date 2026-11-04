/**
 * tms-spot-quoter — reconcile what happened to drafts after we made them (plan §4.5.5).
 *
 * For each DRAFTED request: draft still in Gmail → nothing. Draft gone → look in the
 * thread for a message the rep sent after we drafted: found ⇒ SENT (`REP_GMAIL`), else the
 * rep discarded the draft ⇒ back to NEW. A stale AUTO_PENDING (the process died between
 * the claim and the outcome) is never re-sent; it is released with an honest note.
 */
import type { GmailConnectionRecord, SpotRequestRecord, SpotThreadEntry } from '../../../src/types/tms'
import type { GmailPort } from '../../../src/lib/spot/port'
import type { SpotDeps } from './deps'
import { isoOfInternalDate } from './pipeline'
import { ConflictError, jsonOf } from './store'

export const AUTO_PENDING_STALE_MS = 10 * 60_000

export interface ReconcileResult {
  sent: number
  discarded: number
  released: number
}

export async function reconcileOne(
  deps: SpotDeps,
  port: GmailPort,
  userEmail: string,
  row: SpotRequestRecord,
): Promise<'SENT' | 'DISCARDED' | 'KEPT'> {
  if (!row.draftId) return 'KEPT'
  const draft = await port.getDraft(row.draftId)
  if (draft.exists) return 'KEPT'

  const draftedAt = row.draftedAt ? new Date(row.draftedAt).getTime() : 0
  const messages = row.gmailThreadId ? await port.threadMessages(row.gmailThreadId) : []
  const sentMsg = messages
    .filter((m) => m.labelIds.includes('SENT') && Number(m.internalDate) >= draftedAt)
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))[0]

  try {
    if (!sentMsg) {
      await deps.store.updateRequest(
        row.id,
        { status: 'NEW', draftId: null, draftMessageId: null, draftedAt: null },
        { statusIn: ['DRAFTED'] },
      )
      return 'DISCARDED'
    }
    const at = isoOfInternalDate(sentMsg.internalDate)
    const thread = jsonOf<SpotThreadEntry[]>(row.thread) ?? []
    const known = thread.some((t) => t.id === sentMsg.id)
    await deps.store.updateRequest(
      row.id,
      {
        status: 'SENT',
        sentAt: at,
        sentVia: 'REP_GMAIL',
        ...(known ? {} : { thread: [...thread, { id: sentMsg.id, at, dir: 'OUT', snippet: sentMsg.snippet.replace(/\s+/g, ' ').trim().slice(0, 200) }].slice(-20) }),
      },
      { statusIn: ['DRAFTED'] },
    )
    await deps.store.writeAudit('SPOT_REQUEST', row.id, 'SPOT_SENT', userEmail, { via: 'REP_GMAIL' })
    if (!known) {
      await deps.crm.addSystemActivity({
        customerId: row.customerId ?? undefined,
        contactEmail: row.contactEmail ?? undefined,
        ownerId: row.userId,
        kind: 'EMAIL_OUT',
        at,
        subject: (row.subject ?? '').slice(0, 120) || undefined,
        refs: { spotRequestId: row.id, quoteId: row.quoteId ?? undefined, gmailThreadId: row.gmailThreadId || undefined },
      }).catch((err: unknown) => console.warn('[tms-spot-quoter] crm activity write failed:', String(err)))
    }
    return 'SENT'
  } catch (err) {
    // Someone else moved the row (rep sent from the app, dismissed): theirs wins.
    if (err instanceof ConflictError) return 'KEPT'
    throw err
  }
}

export async function reconcileDrafts(
  deps: SpotDeps,
  conn: Pick<GmailConnectionRecord, 'id' | 'userEmail'>,
  port: GmailPort,
): Promise<ReconcileResult> {
  const out: ReconcileResult = { sent: 0, discarded: 0, released: 0 }
  const rows = await deps.store.requestsByUser(conn.id)
  const nowMs = deps.now().getTime()
  for (const row of rows) {
    if (row.status === 'AUTO_PENDING') {
      const age = nowMs - new Date(row.updatedAt ?? row.receivedAt).getTime()
      if (age < AUTO_PENDING_STALE_MS) continue
      try {
        await deps.store.updateRequest(
          row.id,
          {
            status: 'NEW',
            autoDecision: {
              decision: 'FAILED',
              reasons: [],
              at: deps.now().toISOString(),
              error: 'Auto-send was interrupted and nothing was resent. Check Quotes for a quote from this request.',
            },
          },
          { statusIn: ['AUTO_PENDING'] },
        )
        out.released += 1
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err
      }
      continue
    }
    if (row.status !== 'DRAFTED') continue
    try {
      const outcome = await reconcileOne(deps, port, conn.userEmail, row)
      if (outcome === 'SENT') out.sent += 1
      if (outcome === 'DISCARDED') out.discarded += 1
    } catch (err) {
      console.warn('[tms-spot-quoter] reconcile failed for one request:', String(err))
    }
  }
  return out
}
