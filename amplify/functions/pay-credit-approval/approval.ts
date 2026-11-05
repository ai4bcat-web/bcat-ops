/**
 * Pure pieces of the pay-credit approval Lambda, kept apart from AWS so they can be
 * tested: who may approve, what each action writes, and the Slack wording.
 */
export type ApprovalAction = 'NOTIFY' | 'APPROVE' | 'REJECT'

export interface Caller {
  email: string
  isOwner: boolean
  isAdmin: boolean
}

export interface CreditRow {
  id: string
  driverId: string
  periodStart: string
  kind?: string | null
  reasonCode: string
  label?: string | null
  amount: number
  notes?: string | null
  createdBy?: string | null
  approvalStatus?: string | null
  requestedBy?: string | null
}

export function canApprove(caller: Caller): boolean {
  return caller.isOwner || caller.isAdmin
}

/** Throws when the caller may not perform the action. */
export function authorize(action: ApprovalAction, caller: Caller): void {
  if (!caller.email) throw new Error('Unauthorized: could not resolve caller email')
  if ((action === 'APPROVE' || action === 'REJECT') && !canApprove(caller)) {
    throw new Error(`Forbidden: ${action} requires the owner or an ADMIN`)
  }
}

/** The attribute patch for an approval decision. */
export function decisionPatch(action: 'APPROVE' | 'REJECT', caller: Caller, nowIso: string, reason?: string | null) {
  return {
    approvalStatus:  action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    approvedBy:      caller.email,
    approvedAt:      nowIso,
    rejectionReason: action === 'REJECT' ? (reason?.trim() || null) : null,
  }
}

const money = (n: number) => `$${n.toFixed(2)}`
const firstName = (email: string | null | undefined) => (email ?? '').split('@')[0].replace(/^./, (c) => c.toUpperCase()) || 'someone'

export function requestMessage(input: { credit: CreditRow; driverName: string; periodLabel: string; link: string }): string {
  const { credit, driverName, periodLabel, link } = input
  const who = firstName(credit.requestedBy ?? credit.createdBy)
  const lines = [
    `*Pay credit needs your approval*`,
    `${who} added *${money(credit.amount)}* to *${driverName}*'s ${periodLabel} check (${credit.reasonCode}${credit.label ? ` — ${credit.label}` : ''}).`,
  ]
  if (credit.notes) lines.push(`Note: ${credit.notes}`)
  lines.push(`It stays off the check until you approve it: ${link}`)
  return lines.join('\n')
}

export function decisionMessage(input: { action: 'APPROVE' | 'REJECT'; credit: CreditRow; driverName: string; periodLabel: string; by: string; reason?: string | null }): string {
  const { action, credit, driverName, periodLabel, by, reason } = input
  const what = `${money(credit.amount)} ${credit.reasonCode}${credit.label ? ` — ${credit.label}` : ''} on ${driverName}'s ${periodLabel} check`
  if (action === 'APPROVE') return `${firstName(by)} approved the ${what}. It is on the check.`
  return `${firstName(by)} rejected the ${what}.${reason ? ` Reason: ${reason}` : ''}`
}

/** "Oct 13 – Oct 19" for a YYYY-MM-DD period start (box-truck periods are one week). */
export function periodLabel(periodStart: string, days = 7): string {
  const start = new Date(`${periodStart}T00:00:00Z`)
  const end = new Date(start.getTime() + (days - 1) * 86_400_000)
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `${fmt(start)} – ${fmt(end)}`
}
