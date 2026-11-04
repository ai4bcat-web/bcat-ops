/**
 * Step U3 — the intake e-mail a rev division owns: where tender e-mails for it arrive.
 *
 * One pure module for the division dialog (live message), the directory Lambda (the
 * authoritative refusal) and the router that matches a message's recipients to a
 * division, so the three can never disagree. Imports are relative because the Lambdas
 * bundle this file by path.
 */
import { THREAD_MAILBOX } from './shipmentThread'

/** The bridge's default TENDER address; only one division can own it. */
export const SHARED_TENDERS_MAILBOX = 'tenders@bcatcorp.com'

const COMPANY_DOMAIN = 'bcatcorp.com'

/**
 * Addresses that already mean something else in the mail system and would hijack routing:
 * the catch-all inbox itself and the other agents' bridge inboxes. (`+tracking` plus
 * addresses — shipment reply threads — are refused separately, by shape.)
 */
export const RESERVED_INTAKE_ADDRESSES: readonly string[] = [
  THREAD_MAILBOX,
  `quotes@${COMPANY_DOMAIN}`,
  `carrierinvoices@${COMPANY_DOMAIN}`,
  `trucks@${COMPANY_DOMAIN}`,
  `tasks@${COMPANY_DOMAIN}`,
]

const EMAIL_RE = /^[^\s@,<>;"]+@[^\s@,<>;"]+\.[^\s@,<>;"]+$/

/** Trim and lower-case; an empty value is `null`. */
export function normalizeIntakeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return v === '' ? null : v
}

export type IntakeEmailProblem = 'EMPTY' | 'FORMAT' | 'RESERVED'

export interface IntakeEmailCheck {
  email: string | null
  problem: IntakeEmailProblem | null
  message: string | null
  /** Valid but outside the company / intake-mailbox domains: a warning, never a block. */
  unverifiedDomain: boolean
}

/** Is `raw` an address a division may own? (Duplicates need the division list: `intakeEmailOwner`.) */
export function checkIntakeEmail(raw: unknown): IntakeEmailCheck {
  const email = normalizeIntakeEmail(raw)
  const fail = (problem: IntakeEmailProblem, message: string): IntakeEmailCheck =>
    ({ email, problem, message, unverifiedDomain: false })
  if (email == null) return fail('EMPTY', 'Enter the address tender e-mails for this division arrive at.')
  const at = email.indexOf('@')
  if (email.length > 254 || !EMAIL_RE.test(email) || email.indexOf('@') !== email.lastIndexOf('@') || at > 64) {
    return fail('FORMAT', 'Enter one valid e-mail address, like tenders@bcatcorp.com.')
  }
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (RESERVED_INTAKE_ADDRESSES.includes(email)) {
    return fail('RESERVED', 'That address is already used by another mailbox. Choose a different one.')
  }
  if (local.includes('+tracking')) {
    return fail('RESERVED', 'Addresses with +tracking are shipment reply threads. Choose a different one.')
  }
  const threadDomain = THREAD_MAILBOX.slice(THREAD_MAILBOX.indexOf('@') + 1)
  return { email, problem: null, message: null, unverifiedDomain: domain !== COMPANY_DOMAIN && domain !== threadDomain }
}

interface DivisionAddress { code: string; name: string; active: boolean; intakeEmail?: string | null }

/** The active division already using `email` (case-insensitive), or null. Inactive rows never own one. */
export function intakeEmailOwner<T extends DivisionAddress>(
  divisions: readonly T[],
  email: unknown,
  exceptCode?: string,
): T | null {
  const want = normalizeIntakeEmail(email)
  if (want == null) return null
  return divisions.find((d) => d.active && d.code !== exceptCode && normalizeIntakeEmail(d.intakeEmail) === want) ?? null
}

export interface MailboxSuggestion {
  email: string
  label: string
  note: string
  disabledReason?: string
}

/** The picker's list: two convenience addresses, then whatever other divisions already use. */
export function suggestIntakeMailboxes(
  { divisionCode, divisions }: { divisionCode: string; divisions: readonly DivisionAddress[] },
): MailboxSuggestion[] {
  const [local, domain] = THREAD_MAILBOX.split('@')
  const tag = divisionCode.trim().toLowerCase().replace(/_/g, '-')
  const plus = tag === '' ? null : `${local}+tenders-${tag}@${domain}`
  const base: MailboxSuggestion[] = [
    {
      email: SHARED_TENDERS_MAILBOX,
      label: 'Shared tenders inbox',
      note: "The bridge's default tender address. Only one division can own it.",
    },
    ...(plus ? [{
      email: plus,
      label: 'Plus-address of the intake mailbox',
      note: 'Gmail delivers it with no setup.',
    }] : []),
  ]
  const out = base.map((s) => withOwner(s, divisions, divisionCode))
  const listed = new Set(out.map((s) => s.email))
  for (const d of divisions) {
    const email = normalizeIntakeEmail(d.intakeEmail)
    if (!d.active || d.code === divisionCode || email == null || listed.has(email)) continue
    listed.add(email)
    out.push({ email, label: d.name, note: 'Already in use', disabledReason: `Used by ${d.name}` })
  }
  return out
}

function withOwner(s: MailboxSuggestion, divisions: readonly DivisionAddress[], exceptCode: string): MailboxSuggestion {
  const owner = intakeEmailOwner(divisions, s.email, exceptCode)
  return owner ? { ...s, disabledReason: `Used by ${owner.name}` } : s
}

/**
 * Which division a message was addressed to. Scans `addresses` in the order the bridge
 * reported them (To, Cc, Delivered-To, X-Original-To); the first one an active division owns wins.
 *
 * A division whose address is a seeded placeholder (`intakeEmailConfirmed === false`) owns
 * nothing: nobody has confirmed the mailbox exists, so a message must not be routed by it.
 * `null`/absent means "saved by a person before the flag existed" and keeps routing.
 */
export function matchDivisionByAddresses(
  addresses: readonly string[],
  divisions: ReadonlyArray<{ code: string; active: boolean; intakeEmail?: string | null; intakeEmailConfirmed?: boolean | null }>,
): { divisionCode: string; address: string } | null {
  for (const raw of addresses) {
    const address = normalizeIntakeEmail(raw)
    if (address == null) continue
    const hit = divisions.find(
      (d) => d.active && d.intakeEmailConfirmed !== false && normalizeIntakeEmail(d.intakeEmail) === address,
    )
    if (hit) return { divisionCode: hit.code, address }
  }
  return null
}
