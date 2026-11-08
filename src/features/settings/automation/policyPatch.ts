/**
 * Pure helpers for editing an `AutomationPolicyPatch`: which keys a layer overrides, what
 * is wrong with it, and how long an SMS template reads. No React, so the card and the
 * customer profile validate with the same rules.
 */
import { MAX_SMS_BODY } from '@/lib/dispatch'
import {
  TEMPLATE_KEYS,
  templateProblem,
  type AutomationPolicy,
  type AutomationPolicyPatch,
  type TemplateKey,
} from '@/lib/trackingAutomation'

/** Patch keys other than `templates`, which inherits per template. */
export type PolicyFieldKey = Exclude<keyof AutomationPolicy, 'templates'>

export const SMS_SEGMENT = 160
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function isSmsTemplate(key: TemplateKey): boolean {
  return key === 'checkCallSms' || key === 'podSms'
}

export interface SmsCount { length: number; segments: number; tooLong: boolean }

export function smsCount(text: string): SmsCount {
  return {
    length: text.length,
    segments: text.length === 0 ? 0 : Math.ceil(text.length / SMS_SEGMENT),
    tooLong: text.length > MAX_SMS_BODY,
  }
}

/** A copy of `patch` without `key` (the field inherits again). */
export function withoutField(patch: AutomationPolicyPatch, key: PolicyFieldKey): AutomationPolicyPatch {
  const next = { ...patch }
  delete next[key]
  return next
}

export function withField<K extends PolicyFieldKey>(
  patch: AutomationPolicyPatch, key: K, value: AutomationPolicy[K],
): AutomationPolicyPatch {
  return { ...patch, [key]: value }
}

/** `text === undefined` removes the template key; an empty `templates` object is dropped. */
export function withTemplate(
  patch: AutomationPolicyPatch, key: TemplateKey, text: string | undefined,
): AutomationPolicyPatch {
  const templates = { ...(patch.templates ?? {}) }
  if (text === undefined) delete templates[key]
  else templates[key] = text
  const next = { ...patch }
  if (Object.keys(templates).length) next.templates = templates
  else delete next.templates
  return next
}

/** How many fields this layer overrides (each template counts on its own). */
export function overrideCount(patch: AutomationPolicyPatch | null | undefined): number {
  if (!patch) return 0
  let n = 0
  for (const key of ['checkCallsAuto', 'podAuto', 'podChannels', 'quietHours'] as const) {
    if (patch[key] !== undefined) n += 1
  }
  for (const key of TEMPLATE_KEYS) if (patch.templates?.[key] !== undefined) n += 1
  return n
}

/**
 * Everything that would make a save wrong, as sentences. `inherited` supplies the values
 * the layer does not set itself, so "POD on, no channel" is caught wherever the pieces live.
 */
export function patchProblems(patch: AutomationPolicyPatch, inherited: AutomationPolicy): string[] {
  const problems: string[] = []
  for (const key of TEMPLATE_KEYS) {
    const text = patch.templates?.[key]
    if (text === undefined) continue
    const problem = templateProblem(text, key)
    if (problem) problems.push(problem)
    else if (isSmsTemplate(key) && text.length > MAX_SMS_BODY) {
      problems.push(`Texts are limited to ${MAX_SMS_BODY} characters`)
    }
  }
  const quiet = patch.quietHours
  if (quiet?.enabled) {
    if (!HHMM.test(quiet.start) || !HHMM.test(quiet.end)) problems.push('Quiet hours need start and end times')
    if (!quiet.timezone) problems.push('Quiet hours need a time zone')
    if (quiet.channels.length === 0) problems.push('Pick at least one channel for quiet hours')
  }
  const podAuto = patch.podAuto ?? inherited.podAuto
  const podChannels = patch.podChannels ?? inherited.podChannels
  if (podAuto && podChannels.length === 0) problems.push('Pick at least one channel for automatic POD requests')
  return problems
}
