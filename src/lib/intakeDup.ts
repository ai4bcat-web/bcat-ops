/**
 * The same e-mail can reach the intake mailbox twice (one copy sent to two group addresses, or a Google Group re-sending a message
 * as "<name> via <group>"), and each copy has its own Gmail id, so the bridge files two runs. Two rows are the same e-mail when they
 * arrive within minutes of each other with the same subject (ignoring Re:/Fwd: and quotes) and the same opening text. The sender is
 * deliberately NOT compared: the group copy comes from the group's address. Relative imports only (Lambda-bundled).
 */

export const DUP_WINDOW_MS = 10 * 60 * 1000
const BODY_PREFIX_CHARS = 300
const MIN_PREFIX_CHARS = 15

/** Subject with every leading Re:/Fwd:/Fw: removed, quotes dropped, whitespace collapsed, lower case. */
export function dupSubjectKey(subject: string | null | undefined): string {
  let s = String(subject ?? '').trim()
  for (;;) {
    const next = s.replace(/^\s*(re|fwd?)\s*:\s*/i, '')
    if (next === s) break
    s = next
  }
  return s.replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The first characters of the body, whitespace collapsed, lower case: a group footer is added at the END, so the start still matches. */
export function dupBodyKey(body: string | null | undefined): string {
  return String(body ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, BODY_PREFIX_CHARS)
}

export interface DupProbe { subject?: string | null; bodyText?: string | null; receivedAt?: string | null }

export function isSameEmail(a: DupProbe, b: DupProbe, windowMs = DUP_WINDOW_MS): boolean {
  const ta = Date.parse(String(a.receivedAt ?? ''))
  const tb = Date.parse(String(b.receivedAt ?? ''))
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > windowMs) return false
  const sa = dupSubjectKey(a.subject)
  if (!sa || sa !== dupSubjectKey(b.subject)) return false
  const ba = dupBodyKey(a.bodyText)
  const bb = dupBodyKey(b.bodyText)
  if (ba === '' || bb === '') return false
  // A group copy has a footer added at the end: the shorter body is then the start of the longer one.
  const [short, long] = ba.length <= bb.length ? [ba, bb] : [bb, ba]
  return short === long || (short.length >= MIN_PREFIX_CHARS && long.startsWith(short))
}
