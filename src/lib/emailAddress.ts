// One email-address rule for the browser and the Lambdas. Relative imports only
// (the Lambda bundles this file). The pattern blocks whitespace, CR/LF, commas,
// semicolons, angle brackets and quotes, so an accepted value can never inject a
// header or a second recipient.

export const EMAIL_ADDRESS_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

export const MAX_EMAIL_LENGTH = 200

export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && EMAIL_ADDRESS_RE.test(value)
}

/** Comparison key: trimmed and lower-cased. */
export function emailKey(value: string): string {
  return value.trim().toLowerCase()
}

/** Case-insensitive dedupe; first spelling kept, entries trimmed, empties dropped. */
export function dedupeEmails(list: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const v = raw.trim()
    if (!v) continue
    const key = emailKey(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}
