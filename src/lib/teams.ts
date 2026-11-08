/**
 * Teams: who a rep sits with, and which addresses that desk sends from.
 *
 * A team is configuration — a handful of rows edited by admins — so it lives as JSON
 * on `TmsSettings` rather than in a table. `validateTeams` is the gate that JSON
 * passes through before it is stored: it refuses anything a reader would have to
 * guess about (a key that is not a key, a team with nobody in it, a sender address
 * that is not an address) and normalises everything else, so every consumer can
 * assume trimmed strings, upper-case keys, unique members and a real `active` flag.
 *
 * Membership is matched case-insensitively: a user id is a Cognito username, which is
 * the person's e-mail for everyone invited through the Users page.
 *
 * Pure: no store, no clock, no network. Imports are relative because the Lambdas
 * bundle this file by path.
 */
import type { Team, TeamSenderAddresses } from '../types/tms'

/** The five sender slots a team can own (stored now, wired to SES in J/L). */
export const TEAM_SENDER_SLOTS = [
  'shipment',
  'rateCon',
  'quoteReply',
  'customerInvoice',
  'remittance',
] as const

export type TeamSenderSlot = (typeof TEAM_SENDER_SLOTS)[number]

export const TEAM_SENDER_LABELS: Record<TeamSenderSlot, string> = {
  shipment: 'Shipment e-mails',
  rateCon: 'Rate confirmations',
  quoteReply: 'Quote replies',
  customerInvoice: 'Customer invoices',
  remittance: 'Remittance advice',
}

const MAX_TEAMS = 50
const TEAM_KEY_RE = /^[A-Z0-9_-]{1,24}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The stored `teams` JSON, checked and cleaned, or an `Error` a person can act on.
 * Unknown properties are dropped: what comes back is exactly a `Team[]`.
 */
export function validateTeams(value: unknown): Team[] {
  if (!Array.isArray(value)) throw new Error('Teams must be a list.')
  if (value.length > MAX_TEAMS) throw new Error(`At most ${MAX_TEAMS} teams are allowed.`)

  const teams: Team[] = []
  const keysSeen: string[] = []

  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Every team must be an object.')
    }
    const row = raw as Record<string, unknown>

    const keyInput = text(row.key)
    if (!keyInput) throw new Error('Every team needs a key.')
    if (!TEAM_KEY_RE.test(keyInput)) {
      throw new Error(`Team key "${keyInput}" may only use letters, digits, "-" and "_", up to 24 characters.`)
    }
    const key = keyInput.toUpperCase()
    if (keysSeen.includes(key)) throw new Error(`Team key "${key}" is used twice.`)
    keysSeen.push(key)

    const name = text(row.name)
    if (!name) throw new Error(`Team ${key} needs a name.`)

    const memberInput = Array.isArray(row.memberIds) ? row.memberIds : []
    const memberIds: string[] = []
    for (const member of memberInput) {
      const id = text(member)
      if (!id) throw new Error(`Team ${key} has a blank member.`)
      if (memberIds.some((m) => m.toLowerCase() === id.toLowerCase())) {
        throw new Error(`Team ${key} lists ${id} twice.`)
      }
      memberIds.push(id)
    }
    if (memberIds.length === 0) throw new Error(`Team ${key} needs at least one member.`)

    const senderInput = (row.senderAddresses && typeof row.senderAddresses === 'object'
      ? row.senderAddresses
      : {}) as Record<string, unknown>
    const senderAddresses: TeamSenderAddresses = {}
    let hasSender = false
    for (const slot of TEAM_SENDER_SLOTS) {
      const address = text(senderInput[slot])
      if (!address) continue
      if (!EMAIL_RE.test(address)) {
        throw new Error(`"${address}" is not an e-mail address (team ${key}, ${TEAM_SENDER_LABELS[slot]}).`)
      }
      senderAddresses[slot] = address
      hasSender = true
    }

    const team: Team = { key, name, memberIds, active: row.active !== false }
    if (hasSender) team.senderAddresses = senderAddresses
    if (typeof row.showContactOnTracking === 'boolean') {
      team.showContactOnTracking = row.showContactOnTracking
    }
    teams.push(team)
  }

  return teams
}

/** The user's team — the first ACTIVE one they are in, or null. */
export function teamOf(teams: Team[] | null | undefined, userId: string): Team | null {
  const id = userId.trim().toLowerCase()
  if (!id) return null
  for (const team of teams ?? []) {
    if (team.active === false) continue
    if (team.memberIds.some((m) => m.trim().toLowerCase() === id)) return team
  }
  return null
}

/** Every active team key the user belongs to — what `UserProfile.teamKeys` mirrors. */
export function teamKeysFor(teams: Team[] | null | undefined, userId: string): string[] {
  const id = userId.trim().toLowerCase()
  if (!id) return []
  const keys: string[] = []
  for (const team of teams ?? []) {
    if (team.active === false) continue
    if (team.memberIds.some((m) => m.trim().toLowerCase() === id)) keys.push(team.key)
  }
  return keys
}

/**
 * The address a team sends one kind of mail from, else the fallback. Looked up by key
 * whatever the team's `active` flag says: a shipment that named a team keeps sending
 * from that desk after the team is retired.
 */
export function senderFor(
  teams: Team[] | null | undefined,
  teamKey: string | null | undefined,
  slot: TeamSenderSlot,
  fallback: string,
): string {
  const key = (teamKey ?? '').trim().toLowerCase()
  if (!key) return fallback
  for (const team of teams ?? []) {
    if (team.key.trim().toLowerCase() !== key) continue
    const address = (team.senderAddresses?.[slot] ?? '').trim()
    return address || fallback
  }
  return fallback
}

/**
 * Lower-cased user id → the active team keys they are in, in one pass. The shape the
 * settings save walks to mirror membership onto every `UserProfile.teamKeys`.
 */
export function teamMembership(teams: Team[] | null | undefined): Record<string, string[]> {
  const membership: Record<string, string[]> = {}
  for (const team of teams ?? []) {
    if (team.active === false) continue
    for (const member of team.memberIds) {
      const id = member.trim().toLowerCase()
      if (!id) continue
      const keys = membership[id]
      if (keys) {
        if (!keys.includes(team.key)) keys.push(team.key)
      } else {
        membership[id] = [team.key]
      }
    }
  }
  return membership
}
