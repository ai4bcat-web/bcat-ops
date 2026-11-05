/**
 * Step AS live-check guards. Pure, so the refusals are testable offline.
 *
 * The read-only check never sends anything. The one real invitation (`--live-invite`, run by the lead after
 * the deploy) may go only to ai4bcat@gmail.com (or a +tag of it), for MC 274623, once per run.
 */

export const AS_INVITE_MC = 'MC274623'
const ALLOWED_ADDRESS = /^ai4bcat(\+[a-z0-9._-]+)?@gmail\.com$/i

export const isAllowedInviteAddress = (address) => ALLOWED_ADDRESS.test(String(address ?? '').trim())

/**
 * How the one invitation is sent. If EVERY address MCP returns for the carrier is ai4bcat@gmail.com (or a +tag),
 * the default-list path is exercised (no `emails` passed: the Lambda uses MCP's list). Otherwise the default would
 * reach a real carrier, so the call names ai4bcat@gmail.com explicitly and the default path stays covered by the
 * unit tests. An empty MCP list also falls back to the explicit address.
 */
export function planInvite(mcpAddresses) {
  const list = (mcpAddresses ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean)
  if (list.length > 0 && list.every(isAllowedInviteAddress)) return { mode: 'DEFAULT_LIST', emails: undefined, recipients: list }
  return { mode: 'EXPLICIT', emails: ['ai4bcat@gmail.com'], recipients: ['ai4bcat@gmail.com'] }
}

/** Throws unless the call about to be made can only reach allowed addresses. */
export function assertInviteInputSafe(input, mcpAddresses) {
  const recipients = Array.isArray(input.emails) && input.emails.length > 0 ? input.emails : (mcpAddresses ?? [])
  if (recipients.length === 0) throw new Error('--live-invite refuses: no recipient')
  for (const r of recipients) {
    if (!isAllowedInviteAddress(r)) throw new Error('--live-invite refuses: a recipient is not ai4bcat@gmail.com')
  }
  return input
}

/** E-mails and phone numbers out of text that goes into a screenshot or a log. */
export function maskPii(text) {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[e-mail hidden]')
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone hidden]')
}

/** Deterministic MC candidates to read-only preview when looking for a small carrier outside our directory. */
export function candidateMcs(count, start = 1_000_003, step = 7_919) {
  return Array.from({ length: count }, (_, i) => `MC${start + i * step}`)
}
