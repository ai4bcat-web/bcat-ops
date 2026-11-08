/**
 * Step J — what may leave the credential store, and what may never be written down.
 *
 * Only a last-four mask leaves SSM. `redactSecrets` is run over every message before
 * it reaches an audit row, an event, a log line or the browser, and it strips the
 * base64 form too, because an HTTP client that echoes a basic-auth header would
 * otherwise put the whole credential in the detail string.
 */
import type { CredentialField, CredentialMaskEntry, ProviderDescriptor } from './types'

const REDACTED = '•••'

/**
 * The record of what is stored: one entry per field that holds a value. The last four
 * characters are kept only when there are more than four — a four-character secret
 * masked to itself would be the whole secret. The page reads presence from this list,
 * so a non-secret field is listed too; its value is masked the same way regardless.
 */
export function maskOf(fields: CredentialField[], values: Record<string, string>): CredentialMaskEntry[] {
  const entries: CredentialMaskEntry[] = []
  for (const field of fields) {
    const value = values[field.key]
    if (typeof value !== 'string' || value.trim() === '') continue
    entries.push({ key: field.key, last4: value.length > 4 ? value.slice(-4) : '' })
  }
  return entries
}

function base64Of(value: string): string | null {
  try {
    return btoa(value)
  } catch {
    // Non-latin1 input: a credential that cannot be basic-auth encoded cannot appear
    // in base64 in a provider's echo either.
    return null
  }
}

/**
 * Every credential value, and its base64 form, out of a message. Longest first, so a
 * password that contains the username is not half-replaced by the shorter value.
 */
export function redactSecrets(text: string, values: Array<string | null | undefined>): string {
  const needles = values
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .sort((a, b) => b.length - a.length)

  let out = text
  for (const needle of needles) {
    out = out.split(needle).join(REDACTED)
    const encoded = base64Of(needle)
    if (encoded && encoded !== needle) out = out.split(encoded).join(REDACTED)
  }
  return out
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateCredentials(
  d: ProviderDescriptor,
  input: Record<string, string>,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []

  for (const field of d.credentialFields) {
    const raw = input[field.key]
    const present = typeof raw === 'string' && raw.trim() !== ''

    if (!present) {
      if (!field.optional) errors.push(`${field.label} is required`)
      continue
    }

    if (raw !== raw.trim()) {
      errors.push(`${field.label} must not start or end with a space`)
      continue
    }
    if (field.kind === 'email' && !EMAIL_SHAPE.test(raw)) {
      errors.push(`${field.label} must be an e-mail address`)
      continue
    }
    if (d.key === 'DAT' && field.key === 'serviceAccountEmail' && raw.includes('+')) {
      errors.push(`${field.label} must be a dedicated address without a "+" — DAT refuses a plus address`)
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
