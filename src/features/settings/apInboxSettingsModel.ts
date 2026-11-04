/**
 * Step AG §5.1: the settings form, parsed and checked the way `AP_INBOX_SAVE_SETTINGS` checks it.
 * The server is the authority (a UI bug cannot lower the 0.85 floor); this only spares a round trip.
 */
import type { ApInboxConfig } from '@/lib/apInbox/types'

export interface ApInboxForm {
  enabled: boolean
  mailbox: string
  runHourChicago: string
  lookbackHours: string
  autoApply: boolean
  autoApplyMinScore: string
  reviewMinScore: string
  maxMessagesPerRun: string
  maxModelCallsPerRun: string
  maxAutoAppliesPerRun: string
  dismissedRetentionDays: string
  resolvedRetentionDays: string
  ignoreSenders: string
}

export const formFromConfig = (c: ApInboxConfig): ApInboxForm => ({
  enabled: c.enabled,
  mailbox: c.mailbox,
  runHourChicago: String(c.runHourChicago),
  lookbackHours: String(c.lookbackHours),
  autoApply: c.autoApply,
  autoApplyMinScore: String(c.autoApplyMinScore),
  reviewMinScore: String(c.reviewMinScore),
  maxMessagesPerRun: String(c.maxMessagesPerRun),
  maxModelCallsPerRun: String(c.maxModelCallsPerRun),
  maxAutoAppliesPerRun: String(c.maxAutoAppliesPerRun),
  dismissedRetentionDays: String(c.dismissedRetentionDays),
  resolvedRetentionDays: String(c.resolvedRetentionDays),
  ignoreSenders: c.ignoreSenders.join('\n'),
})

const MAILBOX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function int(label: string, text: string, min: number, max: number): number {
  const n = Number(text)
  if (text.trim() === '' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`)
  return n
}

/** The config to send, or the sentence to show. */
export function parseApInboxForm(f: ApInboxForm): { config: Partial<ApInboxConfig> } | { error: string } {
  try {
    const mailbox = f.mailbox.trim().toLowerCase()
    if (!MAILBOX.test(mailbox)) throw new Error('Mailbox must be an e-mail address')
    const auto = Number(f.autoApplyMinScore)
    const review = Number(f.reviewMinScore)
    if (!Number.isFinite(auto) || auto < 0.85 || auto > 0.99) throw new Error('Auto-update score must be between 0.85 and 0.99')
    if (!Number.isFinite(review) || review < 0.3 || review > Math.round((auto - 0.1) * 100) / 100) {
      throw new Error('Review floor must be at least 0.30 and at least 0.10 below the auto-update score')
    }
    const ignoreSenders = [...new Set(f.ignoreSenders.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean))]
    if (ignoreSenders.length > 100) throw new Error('Ignore at most 100 senders')
    return {
      config: {
        enabled: f.enabled,
        mailbox,
        runHourChicago: int('Run hour', f.runHourChicago, 0, 23),
        lookbackHours: int('Look-back hours', f.lookbackHours, 1, 168),
        autoApply: f.autoApply,
        autoApplyMinScore: auto,
        reviewMinScore: review,
        maxMessagesPerRun: int('E-mails per run', f.maxMessagesPerRun, 1, 500),
        maxModelCallsPerRun: int('Reads per run', f.maxModelCallsPerRun, 1, 300),
        maxAutoAppliesPerRun: int('Auto-updates per run', f.maxAutoAppliesPerRun, 0, 200),
        dismissedRetentionDays: int('Dismissed retention', f.dismissedRetentionDays, 7, 365),
        resolvedRetentionDays: int('Resolved retention', f.resolvedRetentionDays, 7, 365),
        ignoreSenders,
      },
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
