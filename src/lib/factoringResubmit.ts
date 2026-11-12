/**
 * "Send to OTR again": which of three things a row needs, decided from what the row says and
 * what OTR says right now. Shared by the queue (to label the button and the confirmation)
 * and the otr-actions Lambda (to refuse what must not run).
 *
 * The rule that shapes everything: never create a second invoice at OTR while OTR still holds
 * the first as live. An invoice OTR has marked Dead is the only one that may be replaced, and
 * even then the Lambda reads OTR's status again first, because the row's copy can be an hour old.
 */
import type { FactoringItem, OtrPriorInvoice } from '@/types'
import { otrStatusMeta } from './otrInvoiceStatus'

/** Statuses a row can be resent from. A factored, hand-invoiced or archived row is finished. */
const RESENDABLE: ReadonlyArray<FactoringItem['status']> = ['NEED_TO_FACTOR', 'PENDING_WITH_OTR']

export type ResubmitKind =
  /** Never reached OTR (a refused submit): run the ordinary submit again. */
  | 'SUBMIT'
  /** OTR holds it as Dead: create a new invoice, keep the old id on the row's history. */
  | 'REPLACE_DEAD'
  /** OTR holds it and it is not Dead: nothing is created; refresh its status and resend any missing document. */
  | 'REFRESH'

export type ResubmitDecision =
  | { ok: true; kind: ResubmitKind }
  | { ok: false; reason: string }

type Item = Pick<FactoringItem, 'status' | 'otrInvoiceId' | 'otrStatus' | 'brokerCheckResult'>

/**
 * What the button would do, from the row alone (the Lambda repeats this with OTR's live status).
 * `liveStatus` is OTR's current status for the invoice; omit it to judge from the row's copy.
 */
export function decideResubmit(item: Item, liveStatus?: string | number | null): ResubmitDecision {
  if (!RESENDABLE.includes(item.status)) return { ok: false, reason: 'This row has already left the OTR queue.' }
  if (item.brokerCheckResult === 'NO_BUY') return { ok: false, reason: 'OTR will not buy from this broker. Invoice it manually instead.' }
  if (item.brokerCheckResult === 'NOT_APPROVED') return { ok: false, reason: 'OTR has not approved this broker, so a new submission would be rejected.' }
  if (!item.otrInvoiceId) return { ok: true, kind: 'SUBMIT' }
  const meta = otrStatusMeta(liveStatus !== undefined ? liveStatus : item.otrStatus)
  if (meta?.code === 4) return { ok: true, kind: 'REPLACE_DEAD' }
  return { ok: true, kind: 'REFRESH' }
}

/** Does this row get a "Send to OTR again" button? Dead, refused or errored rows only. */
export function offersResend(item: Item & Pick<FactoringItem, 'otrError' | 'brokerMcChecked' | 'manualReason'>): boolean {
  const d = decideResubmit(item)
  if (!d.ok) return false
  if (item.otrInvoiceId) return otrStatusMeta(item.otrStatus)?.code === 4 || !!item.otrError?.trim()
  return !!item.otrError?.trim()
}

/** Append the invoice a resend just replaced to the row's history (newest last). */
export function withPriorInvoice(
  prior: readonly OtrPriorInvoice[] | null | undefined,
  replaced: Pick<FactoringItem, 'otrInvoiceId' | 'otrStatus' | 'otrSubmittedAt' | 'otrSubmittedBy'>,
  by: string,
  at: string,
): OtrPriorInvoice[] {
  return [
    ...(prior ?? []),
    {
      otrInvoiceId: String(replaced.otrInvoiceId ?? ''),
      otrStatus: replaced.otrStatus != null ? String(replaced.otrStatus) : null,
      otrSubmittedAt: replaced.otrSubmittedAt ?? null,
      otrSubmittedBy: replaced.otrSubmittedBy ?? null,
      replacedAt: at,
      replacedBy: by,
    },
  ]
}

/** OTR answered a repeat create with the same invoice id: nothing new exists, and the row must not change. */
export function sameInvoiceBack(oldId: string | null | undefined, createdId: string | number): boolean {
  return String(oldId ?? '').trim() === String(createdId).trim()
}
