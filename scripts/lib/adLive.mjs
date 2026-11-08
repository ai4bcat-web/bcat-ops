/**
 * Step AD live-test guards. The only MyCarrierPackets carrier the harness may touch with `--live` is
 * Ivan Cartage (MC 274623, Ryne's own company), and the only address it may invite is the allow-list
 * below. Everything here is pure so the refusals are testable without a network.
 */

export const LIVE_TEST_MC = 'MC274623'
/** Hard-coded on purpose: widening this is a code change someone has to read. */
export const LIVE_INVITE_ALLOW_LIST = Object.freeze(['ai4bcat@gmail.com'])
export const LIVE_TEST_NAME = /\bivan\b/i

const mcDigits = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MC0*/, '')

/** The invitation address, normalised, or a thrown refusal. Anything off the allow-list is refused. */
export function assertLiveInviteAllowed(email) {
  const normalised = String(email ?? '').trim().toLowerCase()
  if (!LIVE_INVITE_ALLOW_LIST.includes(normalised)) {
    throw new Error(`--live refuses to invite ${normalised ? 'that address' : 'an empty address'}: only ${LIVE_INVITE_ALLOW_LIST.join(', ')} is allowed`)
  }
  return normalised
}

/** The carrier a live call may name: MC 274623 and nothing else (a DOT-only ref is refused). */
export function assertLiveCarrierAllowed(ref) {
  if (mcDigits(ref?.mcNumber) !== mcDigits(LIVE_TEST_MC) || ref?.dotNumber) {
    throw new Error(`--live refuses carrier ${ref?.mcNumber ?? ref?.dotNumber ?? '(none)'}: only ${LIVE_TEST_MC} (by MC, no DOT) may be looked up or invited`)
  }
  return { mcNumber: LIVE_TEST_MC }
}

/**
 * Before the invitation: the card MCP returned for MC 274623 must be that company. A wrong carrier
 * behind the number (or an empty card) stops the send.
 */
export function assertLiveCardIsIvan(card) {
  const name = card?.identity?.legalName ?? ''
  if (!LIVE_TEST_NAME.test(name)) throw new Error('--live stops: the card for MC 274623 is not Ivan Cartage, so no invitation is sent')
  if (mcDigits(card?.identity?.mcNumber) !== mcDigits(LIVE_TEST_MC)) throw new Error('--live stops: the card does not carry MC 274623')
  return card
}

/** At most one invitation per run: a second call throws before anything is sent. */
export function createInviteBudget(limit = 1) {
  let used = 0
  return {
    take() {
      if (used >= limit) throw new Error(`--live sends exactly ${limit} invitation; a second one is refused`)
      used += 1
    },
    get used() { return used },
  }
}

/** Key names of a JSON object (never values): the shape evidence the log may carry. */
export function keysOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
}

/** A secret-looking token must never reach the log. */
const SECRET_LIKE = /(bearer\s+[a-z0-9._-]{8,}|password|authorization|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/i
export function assertNoSecret(text) {
  if (SECRET_LIKE.test(text)) throw new Error('refusing to write a log that looks like it carries a credential')
  return text
}

/** The MCP_LIVE_TEST.md section for one run. Status and body key names only. */
export function liveLogSection({ at, mode, lookup, invite }) {
  const rows = [
    `## ${at} — Step AD live test (MC 274623, Ivan Cartage)`,
    '',
    `- Server mode on the lookups: ${mode}`,
    `- PreviewCarrier: ${lookup.preview.found ? 'record found' : 'no record'}; keys of the card: ${lookup.preview.cardKeys.join(', ') || '(none)'}`,
    `- GetCarrierData: ${lookup.data.found ? 'record found' : 'no record'}; packet status: ${lookup.data.packetStatus ?? '(none)'}`,
    `- Card: risk ${lookup.risk ?? '(none)'}, insurance rows ${lookup.insuranceRows}, approved e-mails ${lookup.approvedEmails}`,
    invite
      ? `- EmailPacketInvitation to ${invite.to}: sent=${invite.sent}, mode=${invite.mode}, MCP HTTP status ${invite.status ?? '(n/a)'}, response keys: ${invite.bodyKeys.join(', ') || '(none)'}, carrier row logged=${invite.carrierLogged}`
      : '- EmailPacketInvitation: not sent in this run',
    '',
  ]
  return assertNoSecret(rows.join('\n'))
}
