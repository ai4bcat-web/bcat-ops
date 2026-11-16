/**
 * The one reader for a customer's AP / invoice e-mails (Ryne 2026-11-16, 14815 WHIMSY). A customer's addresses are
 * `apEmail` (the main one) then `apEmailsExtra`. Older records hold several addresses in one string
 * ("gomara@x.com, jgudel@x.com"), which no single-address check accepts, so every reader splits on commas,
 * semicolons and whitespace, trims, lowercases and de-duplicates here. Pure and import-free: the board, Load Review,
 * the customer forms and the Lambdas (release gate, invoice send, aging statements) all read the same list.
 */

const EMAIL_RE = /^[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[^\s@,;<>()[\]]+$/

export interface ApEmailFields {
  apEmail?: string | null
  apEmailsExtra?: readonly (string | null | undefined)[] | null
}

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value.trim())
}

/** Every token in a typed or pasted list: split on commas, semicolons, whitespace; lowercased, de-duplicated. */
export function splitEmailText(text: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    const email = part.trim().replace(/^<|>$/g, '').toLowerCase()
    if (email && !out.includes(email)) out.push(email)
  }
  return out
}

/** Every token across apEmail + apEmailsExtra, main address first, valid or not. */
export function apEmailTokens(c: ApEmailFields | null | undefined): string[] {
  if (!c) return []
  const out: string[] = []
  for (const raw of [c.apEmail, ...(c.apEmailsExtra ?? [])]) {
    for (const email of splitEmailText(raw)) if (!out.includes(email)) out.push(email)
  }
  return out
}

/** The customer's usable AP addresses, main first. "Has an AP e-mail" means this is non-empty. */
export function apEmailList(c: ApEmailFields | null | undefined): string[] {
  return apEmailTokens(c).filter(isEmailAddress)
}

/** Tokens that are not addresses (shown red; never saved or sent). */
export function invalidApEmails(c: ApEmailFields | null | undefined): string[] {
  return apEmailTokens(c).filter((e) => !isEmailAddress(e))
}

/** The storage shape for a list: the first address in `apEmail`, the rest in `apEmailsExtra` (null when none). */
export function apEmailStorage(list: readonly string[]): { apEmail: string | null; apEmailsExtra: string[] | null } {
  const clean = splitEmailText(list.join(' '))
  return { apEmail: clean[0] ?? null, apEmailsExtra: clean.length > 1 ? clean.slice(1) : null }
}
