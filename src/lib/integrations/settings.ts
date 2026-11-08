/**
 * Step J — the behaviour card, validated against the descriptor.
 *
 * The settings card is editable before a credential ever arrives (DAT's contact method
 * can be chosen while DAT is still a stub), so this runs on its own and refuses
 * anything the provider would not accept: an unknown key, a wrong type, a number off
 * its step, a select value nobody offered.
 */
import type { ProviderDescriptor, SettingsField } from './types'

export function defaultSettingsOf(d: ProviderDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of d.settingsFields) {
    if (field.defaultValue !== undefined) {
      out[field.key] = field.defaultValue
    } else if (field.type === 'json') {
      // A fresh object each call: a shared default would be mutated by the first caller.
      out[field.key] = {}
    }
  }
  return out
}

function checkNumber(field: SettingsField, value: number, errors: string[]): void {
  if (!Number.isFinite(value)) {
    errors.push(`${field.label} must be a number`)
    return
  }
  if (typeof field.min === 'number' && value < field.min) {
    errors.push(`${field.label} must be at least ${field.min}`)
  }
  if (typeof field.max === 'number' && value > field.max) {
    errors.push(`${field.label} must be at most ${field.max}`)
  }
  if (typeof field.step === 'number' && field.step > 0) {
    const base = typeof field.min === 'number' ? field.min : 0
    const steps = (value - base) / field.step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      errors.push(`${field.label} must be ${base} plus a multiple of ${field.step}`)
    }
  }
}

/**
 * The stored shape: every declared field, defaulted where the caller said nothing,
 * coerced to the declared type. Unknown keys are an error rather than dropped — a
 * misspelled toggle that silently disappears is a setting the user thinks they saved.
 */
export function validateProviderSettings(
  d: ProviderDescriptor,
  settings: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const declared: Record<string, SettingsField> = Object.fromEntries(
    d.settingsFields.map((f) => [f.key, f]),
  )

  for (const key of Object.keys(settings)) {
    if (!declared[key]) errors.push(`${d.label} has no setting named "${key}"`)
  }

  const value = defaultSettingsOf(d)
  for (const field of d.settingsFields) {
    const given = settings[field.key]
    if (given === undefined || given === null) continue

    switch (field.type) {
      case 'boolean':
        if (typeof given !== 'boolean') errors.push(`${field.label} must be true or false`)
        else value[field.key] = given
        break
      case 'number':
        if (typeof given !== 'number') {
          errors.push(`${field.label} must be a number`)
        } else {
          checkNumber(field, given, errors)
          value[field.key] = given
        }
        break
      case 'select':
        if (typeof given !== 'string' || !(field.options ?? []).some((o) => o.value === given)) {
          errors.push(`${field.label} must be one of: ${(field.options ?? []).map((o) => o.value).join(', ')}`)
        } else {
          value[field.key] = given
        }
        break
      case 'text':
        if (typeof given !== 'string') errors.push(`${field.label} must be text`)
        else value[field.key] = given
        break
      case 'json':
        // Opaque to this file: the QuickBooks mapping cards own its shape, and the
        // behaviour card never renders it. An array or a primitive is still refused —
        // the store expects an object it can merge.
        if (typeof given !== 'object' || Array.isArray(given)) {
          errors.push(`${field.label} must be an object`)
        } else {
          value[field.key] = given
        }
        break
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}
