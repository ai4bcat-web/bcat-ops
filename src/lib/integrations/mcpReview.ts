/**
 * Step AD — the carrier review card. Pure: MyCarrierPackets' PreviewCarrier / GetCarrierData
 * bodies -> `McpReviewCard`, laid out like MCP's own review screen (header chips, risk gauge,
 * insurance table, authority timeline, contacts), plus the stub fixtures, the invite e-mail
 * picker rules and the "already in our directory" match.
 *
 * Nothing here reads a table or calls MCP. Casing in MCP's DTOs is mixed, so every read goes
 * through the case-insensitive `field`. Never carried: SSN, bank numbers, credentials.
 */
import { docketOf, field, flat, isoOf, list, normalizeMcpCarrier, text } from './mcpAdapter'
import type { McpCarrierStatus } from './mcpAdapter'
import { dotKey, mcKey, normalizeMcpProfile } from './mcpProfile'
import type { McpContact } from './mcpProfile'
import { normalizeName } from '../tmsDirectory'

export type ReviewTone = 'green' | 'amber' | 'red' | 'gray'

export interface ReviewInsuranceRow {
  type: string
  insurer?: string
  policyNumber?: string
  limitCents?: number
  limitText?: string
  deductible?: string
  expiresAt?: string
  cancelledAt?: string
  state: 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'UNKNOWN'
}

export interface ReviewRiskCategory {
  key: 'authority' | 'insurance' | 'safety' | 'operation' | 'other'
  label: string
  points?: number
  rating?: string
  tone: ReviewTone
  infractions: string[]
}

export interface ReviewTimelineEntry {
  label: string
  at?: string
  detail?: string
}

/** One address MyCarrierPackets returns for the carrier: where it came from and what it is for. */
export interface McpReviewEmail {
  address: string
  source: 'MCP_APPROVED' | 'MCP_PROFILE' | 'MCP_CONTACT'
  label: string
}

export interface McpReviewCard {
  /** LIVE = answered by MyCarrierPackets; STUB = a labelled fixture, nothing was called. */
  source: 'LIVE' | 'STUB'
  identity: {
    legalName?: string
    dbaName?: string
    mcNumber?: string
    dotNumber?: string
    phone?: string
    email?: string
    website?: string
    address?: string
  }
  operating: {
    status?: string
    statusDate?: string
    inProcessState?: string
    safetyRating?: string
    safetyRatingDate?: string
    authorityStatus?: 'ACTIVE' | 'INACTIVE'
    common?: string
    contract?: string
    broker?: string
    possibleFraud?: string
    doubleBrokering?: string
    incidentReports?: { total: number; withFraud: number }
    nonCooperative?: boolean
    intrastate?: boolean
    freightValidate?: string
  }
  risk: {
    totalPoints?: number
    overallRating?: string
    tone: ReviewTone
    reviewState?: string
    review?: { user?: string; date?: string; reason?: string; note?: string; expires?: string }
    categories: ReviewRiskCategory[]
  }
  insurance: ReviewInsuranceRow[]
  timeline: ReviewTimelineEntry[]
  contacts: McpContact[]
  approvedEmails: Array<{ email: string; description?: string }>
  /** Step AS. Every e-mail MCP returns (approved, FMCSA / profile, packet and dispatch / billing contacts), lower-cased, deduped. The invite defaults to all of them. */
  emails: McpReviewEmail[]
  equipment: {
    powerUnits?: number
    tractors?: number
    trailers?: number
    drivers?: number
    eld?: string
    lanes: string[]
    cargo: string[]
    modes: string[]
  }
  packet: {
    status: McpCarrierStatus
    label: string
    completed: boolean
    completedAt?: string
    rawStatuses: string[]
    onCurrentAgreement?: boolean
    invitedAt?: string
    invitedTo?: string
    rating?: string
  }
  monitoring: { monitored: boolean | null; blocked: boolean | null }
  /** Which MCP endpoints answered; the card is complete once `data` is true. */
  fetched: { preview: boolean; data: boolean }
}

export const PACKET_LABELS: Record<McpCarrierStatus, string> = {
  NOT_INVITED: 'Not invited',
  INVITED: 'Invited',
  IN_PROGRESS: 'Packet in progress',
  PENDING_REVIEW: 'Packet complete, pending review',
  ACCEPTABLE: 'Packet complete, acceptable',
  MODERATE: 'Packet complete, moderate risk',
  UNACCEPTABLE: 'Packet complete, unacceptable',
  UNACCEPTABLE_REVIEW: 'Unacceptable, under review',
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[^0-9.-]/g, '')) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Free-text risk rating -> a colour. Unreadable text is gray, never green. */
export function riskTone(rating: string | undefined): ReviewTone {
  const r = flat(rating)
  if (!r) return 'gray'
  if (/unaccept|fail|high|red|reject|deny/.test(r)) return 'red'
  if (/moderate|medium|caution|yellow|elevated/.test(r)) return 'amber'
  if (/accept|pass|low|green|approv|good/.test(r)) return 'green'
  return 'gray'
}

const humanize = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\bU S\b/, 'US').replace(/^./, (c) => c.toUpperCase())

/** The names of a DTO's `true` flags (lanes, cargo hauled, modes), humanised. */
function trueKeys(obj: unknown, skip: RegExp = /^(id|carrier|created|updated|modified)/i): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  return Object.entries(obj as Record<string, unknown>)
    .filter(([k, v]) => v === true && !skip.test(k))
    .map(([k]) => humanize(k))
}

const addressText = (...parts: unknown[]): string | undefined => {
  const [street, street2, city, state, zip] = parts.map(text)
  const line2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  const out = [[street, street2].filter(Boolean).join(' '), line2].filter(Boolean).join(', ')
  return out || undefined
}

const limitCentsOf = (raw: string | undefined): number | undefined => {
  const digits = (raw ?? '').replace(/[^0-9.]/g, '')
  const n = digits ? Math.round(Number(digits) * 100) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function insuranceRows(certData: unknown, nowMs: number): ReviewInsuranceRow[] {
  const rows: ReviewInsuranceRow[] = []
  for (const cert of [...list(field(certData, 'Certificates')), ...list(field(certData, 'Certificate'))]) {
    for (const cov of [...list(field(cert, 'Coverages')), ...list(field(cert, 'Coverage'))]) {
      const expiresAt = isoOf(field(cov, 'ExpirationDate'))
      const cancelledAt = isoOf(field(cov, 'CancellationDate'))
      const limitText = text(field(cov, 'CoverageLimit'))
      const state: ReviewInsuranceRow['state'] = cancelledAt ? 'CANCELLED' : !expiresAt ? 'UNKNOWN' : Date.parse(expiresAt) > nowMs ? 'ACTIVE' : 'EXPIRED'
      rows.push({
        type: text(field(cov, 'Type')) ?? 'Coverage',
        ...(text(field(cov, 'InsurerName')) ? { insurer: text(field(cov, 'InsurerName'))! } : {}),
        ...(text(field(cov, 'PolicyNumber')) ? { policyNumber: text(field(cov, 'PolicyNumber'))! } : {}),
        ...(limitCentsOf(limitText) ? { limitCents: limitCentsOf(limitText)! } : {}),
        ...(limitText ? { limitText } : {}),
        ...(text(field(cov, 'Deductible')) ? { deductible: text(field(cov, 'Deductible'))! } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(cancelledAt ? { cancelledAt } : {}),
        state,
      })
    }
  }
  return rows
}

const RISK_KEYS: Array<[ReviewRiskCategory['key'], string]> = [
  ['authority', 'Authority'], ['insurance', 'Insurance'], ['safety', 'Safety'], ['operation', 'Operation'], ['other', 'Other'],
]

function riskCategories(details: unknown, summary: unknown): ReviewRiskCategory[] {
  const out: ReviewRiskCategory[] = []
  for (const [key, label] of RISK_KEYS) {
    const d = field(details, label)
    const rating = text(field(d, 'OverallRating')) ?? text(field(summary, label))
    const points = num(field(d, 'TotalPoints'))
    const infractions = list(field(d, 'Infractions')).flatMap((i) => {
      const t = typeof i === 'string' ? text(i) : text(field(i, 'Description')) ?? text(field(i, 'Name')) ?? text(field(i, 'Infraction')) ?? text(field(i, 'Message'))
      const p = typeof i === 'object' ? num(field(i, 'Points')) : undefined
      return t ? [p != null ? `${t} (${p} pts)` : t] : []
    })
    if (rating == null && points == null && infractions.length === 0) continue
    out.push({ key, label, ...(points != null ? { points } : {}), ...(rating ? { rating } : {}), tone: riskTone(rating), infractions })
  }
  return out
}

/** The four statuses the guide gives free text for, read into one stage. */
function packetOf(root: unknown, cd: unknown, mcpStatus: McpCarrierStatus, completedAt: string | undefined): McpReviewCard['packet'] {
  const rawStatuses = list(field(root, 'CarrierCustomerPacketStatuses')).flatMap((s) => {
    const t = text(field(s, 'CarrierPacketStatus'))
    return t ? [t] : []
  })
  const invitation = field(cd, 'LatestInvitation')
  const invitedAt = isoOf(field(invitation, 'InvitationSentDate'))
  const onAgreement = field(root, 'OnCurrentCustomerAgreement')
  return {
    status: mcpStatus,
    label: PACKET_LABELS[mcpStatus],
    completed: !['NOT_INVITED', 'INVITED', 'IN_PROGRESS'].includes(mcpStatus),
    ...(completedAt ? { completedAt } : {}),
    rawStatuses,
    ...(typeof onAgreement === 'boolean' ? { onCurrentAgreement: onAgreement } : {}),
    ...(invitedAt ? { invitedAt } : {}),
    ...(text(field(invitation, 'InvitationRecipient')) ? { invitedTo: text(field(invitation, 'InvitationRecipient'))! } : {}),
    ...(text(field(field(root, 'CarrierRating'), 'RatingValueText')) ? { rating: text(field(field(root, 'CarrierRating'), 'RatingValueText'))! } : {}),
  }
}

const authorityLine = (value: string | undefined, pending: unknown, revocation: unknown): string | undefined => {
  if (!value) return undefined
  const extra = [text(pending) === 'Y' || pending === true ? 'application pending' : '', text(revocation) === 'Y' || revocation === true ? 'revocation pending' : ''].filter(Boolean)
  return extra.length ? `${value} (${extra.join(', ')})` : value
}

const CONTACT_LABEL: Record<string, string> = { DISPATCH: 'Dispatch', CLAIMS: 'Claims', OWNER: 'Owner', AFTER_HOURS: 'After hours', MANAGER: 'Manager', BILLING: 'Billing' }

/** Approved first, then the FMCSA / profile address, then each contact's: one entry per lower-cased address. */
function collectEmails(approved: McpReviewCard['approvedEmails'], profileEmail: string | undefined, contacts: McpContact[], carrierBillingEmail?: string): McpReviewEmail[] {
  const out = new Map<string, McpReviewEmail>()
  const add = (raw: string | undefined, source: McpReviewEmail['source'], label: string) => {
    const address = raw?.trim().toLowerCase()
    if (address && !out.has(address)) out.set(address, { address, source, label })
  }
  for (const e of approved) add(e.email, 'MCP_APPROVED', e.description ?? 'Approved by MyCarrierPackets')
  add(profileEmail, 'MCP_PROFILE', 'Carrier profile / FMCSA')
  for (const c of contacts) add(c.email, 'MCP_CONTACT', c.types.map((t) => CONTACT_LABEL[t] ?? t).join(', ') || c.name)
  add(carrierBillingEmail, 'MCP_CONTACT', 'Billing')
  return [...out.values()]
}

/**
 * One PreviewCarrier or GetCarrierData body -> the review card. Null when MCP knows no carrier.
 * `data` says which endpoint answered, so the page can tell a thin preview from the full record.
 */
export function buildReviewCard(
  raw: unknown,
  ref: { mcNumber?: string; dotNumber?: string } = {},
  endpoint: 'preview' | 'data' = 'data',
  nowMs: number = Date.now(),
): McpReviewCard | null {
  const root = Array.isArray(raw) ? raw[0] : raw
  const profile = normalizeMcpProfile(root, ref, nowMs)
  const carrier = normalizeMcpCarrier(root, ref, nowMs)
  if (!profile || !carrier) return null

  const cd = field(list(field(root, 'AssureAdvantage'))[0], 'CarrierDetails') ?? root
  const authority = field(cd, 'Authority')
  const safety = field(cd, 'Safety')
  const details = field(root, 'RiskAssessmentDetails') ?? field(cd, 'RiskAssessmentDetails')
  const summary = field(root, 'RiskAssessment') ?? field(cd, 'RiskAssessment')
  const overall = text(field(details, 'OverallRating')) ?? text(field(summary, 'Overall'))
  const certData = field(root, 'CertData') ?? field(cd, 'CertData')
  const review = field(details, 'ReviewDetails')
  const op = field(root, 'CarrierOperationalDetail')
  const eld = field(root, 'CarrierELDProvider')
  const incidents = field(root, 'IncidentReports')

  const grantedAt = profile.authorityGrantedAt
  const common = authorityLine(text(field(authority, 'commonAuthority')), field(authority, 'commonAuthorityPending'), field(authority, 'commonAuthorityRevocation'))
  const contract = authorityLine(text(field(authority, 'contractAuthority')), field(authority, 'contractAuthorityPending'), field(authority, 'contractAuthorityRevocation'))
  const broker = authorityLine(text(field(authority, 'brokerAuthority')), field(authority, 'brokerAuthorityPending'), field(authority, 'brokerAuthorityRevocation'))
  const statusDate = isoOf(field(root, 'StatusDate'))
  const safetyDate = profile.safetyRatingAt
  const reviewDate = isoOf(field(review, 'ReviewDate'))
  const invitedAt = isoOf(field(field(cd, 'LatestInvitation'), 'InvitationSentDate'))

  const timeline: ReviewTimelineEntry[] = []
  if (grantedAt) timeline.push({ label: 'Authority granted', at: grantedAt, detail: [common && `Common ${common}`, contract && `Contract ${contract}`, broker && `Broker ${broker}`].filter(Boolean).join(' · ') || undefined })
  if (statusDate) timeline.push({ label: `Operating status: ${text(field(root, 'Status')) ?? 'on file'}`, at: statusDate })
  if (safetyDate) timeline.push({ label: `Safety rating: ${text(field(safety, 'rating')) ?? 'on file'}`, at: safetyDate })
  for (const row of insuranceRows(certData, nowMs)) {
    if (row.cancelledAt) timeline.push({ label: `${row.type} cancelled`, at: row.cancelledAt, detail: row.insurer })
    else if (row.expiresAt) timeline.push({ label: `${row.type} ${row.state === 'EXPIRED' ? 'expired' : 'expires'}`, at: row.expiresAt, detail: row.insurer })
  }
  if (reviewDate) timeline.push({ label: 'Risk review', at: reviewDate, detail: text(field(review, 'ReviewReason')) })
  if (invitedAt) timeline.push({ label: 'Packet invitation sent', at: invitedAt, detail: text(field(field(cd, 'LatestInvitation'), 'InvitationRecipient')) })
  if (carrier.packetCompletedAt) timeline.push({ label: 'Packet completed', at: carrier.packetCompletedAt })
  timeline.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))

  const approved = [...list(field(root, 'Emails')), ...list(field(cd, 'Emails'))].flatMap((e) => {
    const email = text(field(e, 'Email'))?.toLowerCase()
    return email ? [{ email, ...(text(field(e, 'Description')) ? { description: text(field(e, 'Description'))! } : {}) }] : []
  })
  const byAddress = new Map<string, { email: string; description?: string }>()
  for (const e of approved) {
    const prev = byAddress.get(e.email)
    if (!prev) byAddress.set(e.email, e)
    else if (!prev.description && e.description) byAddress.set(e.email, e)
  }
  const approvedEmails = [...byAddress.values()]
  const emails = collectEmails(approvedEmails, profile.email, profile.contacts, profile.payment?.recipientType === 'CARRIER' ? profile.payment.payeeEmail : undefined)

  const tractors = num(field(op, 'NumberOfTractors')) ?? num(field(op, 'OwnedTractors'))
  const drivers = num(field(op, 'CDLEmployedDrivers')) ?? num(field(op, 'InterstateDriversTotal'))
  const trailers = (num(field(op, 'NumberOfVans')) ?? 0) + (num(field(op, 'NumberOfReefers')) ?? 0) + (num(field(op, 'NumberOfFlats')) ?? 0)
  const eldName = text(field(eld, 'ProviderName'))

  const operatingStatus = text(field(root, 'Status'))
  return {
    source: 'LIVE',
    identity: {
      ...(profile.legalName ? { legalName: profile.legalName } : {}),
      ...(profile.dbaName ? { dbaName: profile.dbaName } : {}),
      ...(carrier.mcNumber ? { mcNumber: carrier.mcNumber } : {}),
      ...(carrier.dotNumber ? { dotNumber: carrier.dotNumber } : {}),
      ...(profile.phone ? { phone: profile.phone } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.website ? { website: profile.website } : {}),
      ...(addressText(profile.address?.street, undefined, profile.address?.city, profile.address?.state, profile.address?.zip) ? { address: addressText(profile.address?.street, undefined, profile.address?.city, profile.address?.state, profile.address?.zip)! } : {}),
    },
    operating: {
      ...(operatingStatus ? { status: operatingStatus } : {}),
      ...(statusDate ? { statusDate } : {}),
      ...(text(field(root, 'InProcessState')) ? { inProcessState: text(field(root, 'InProcessState'))! } : {}),
      ...(text(field(safety, 'rating')) ? { safetyRating: text(field(safety, 'rating'))! } : {}),
      ...(safetyDate ? { safetyRatingDate: safetyDate } : {}),
      ...(carrier.authorityStatus ? { authorityStatus: carrier.authorityStatus } : {}),
      ...(common ? { common } : {}),
      ...(contract ? { contract } : {}),
      ...(broker ? { broker } : {}),
      ...(text(field(root, 'PossibleFraud')) ? { possibleFraud: text(field(root, 'PossibleFraud'))! } : {}),
      ...(text(field(root, 'DoubleBrokering')) ? { doubleBrokering: text(field(root, 'DoubleBrokering'))! } : {}),
      ...(num(field(incidents, 'TotalIncidentReports')) != null ? { incidentReports: { total: num(field(incidents, 'TotalIncidentReports'))!, withFraud: num(field(incidents, 'TotalIncidentReportsWithFraud')) ?? 0 } } : {}),
      ...(typeof field(certData, 'Noncoop') === 'boolean' || typeof field(certData, 'noncoop') === 'boolean' ? { nonCooperative: (field(certData, 'Noncoop') ?? field(certData, 'noncoop')) === true } : {}),
      ...(typeof field(root, 'IsIntrastateCarrier') === 'boolean' ? { intrastate: field(root, 'IsIntrastateCarrier') === true } : {}),
      ...(text(field(root, 'FreightValidateStatus')) ? { freightValidate: text(field(root, 'FreightValidateStatus'))! } : {}),
    },
    risk: {
      ...(carrier.riskAssessmentPoints != null ? { totalPoints: carrier.riskAssessmentPoints } : {}),
      ...(overall ? { overallRating: overall } : {}),
      tone: riskTone(overall),
      ...(text(field(details, 'ReviewState')) ? { reviewState: text(field(details, 'ReviewState'))! } : {}),
      ...(review ? { review: {
        ...(text(field(review, 'ReviewUser')) ? { user: text(field(review, 'ReviewUser'))! } : {}),
        ...(reviewDate ? { date: reviewDate } : {}),
        ...(text(field(review, 'ReviewReason')) ? { reason: text(field(review, 'ReviewReason'))! } : {}),
        ...(text(field(review, 'ReviewNote')) ? { note: text(field(review, 'ReviewNote'))! } : {}),
        ...(isoOf(field(review, 'ReviewExpirationDate')) ? { expires: isoOf(field(review, 'ReviewExpirationDate'))! } : {}),
      } } : {}),
      categories: riskCategories(details, summary),
    },
    insurance: insuranceRows(certData, nowMs),
    timeline,
    contacts: profile.contacts,
    approvedEmails,
    emails,
    equipment: {
      ...(profile.powerUnits ? { powerUnits: profile.powerUnits } : {}),
      ...(tractors ? { tractors } : {}),
      ...(trailers ? { trailers } : {}),
      ...(drivers ? { drivers } : {}),
      ...(eldName ? { eld: eldName } : {}),
      lanes: trueKeys(field(root, 'CarrierLane')),
      cargo: trueKeys(field(root, 'CarrierCargoHauled')),
      modes: trueKeys(field(root, 'CarrierMode')),
    },
    packet: packetOf(root, cd, carrier.status, carrier.packetCompletedAt),
    monitoring: {
      monitored: typeof field(root, 'IsMonitored') === 'boolean' ? field(root, 'IsMonitored') === true : null,
      blocked: typeof field(root, 'IsBlocked') === 'boolean' ? field(root, 'IsBlocked') === true : null,
    },
    fetched: { preview: endpoint === 'preview', data: endpoint === 'data' },
  }
}

/** Fold the GetCarrierData card over the PreviewCarrier card: the full record wins, the preview fills the gaps. */
export function mergeReviewCards(preview: McpReviewCard | null, data: McpReviewCard | null): McpReviewCard | null {
  if (!preview) return data
  if (!data) return preview
  const pick = <T,>(a: T[], b: T[]): T[] => (a.length > 0 ? a : b)
  return {
    source: data.source,
    identity: { ...preview.identity, ...data.identity },
    operating: { ...preview.operating, ...data.operating },
    risk: { ...data.risk, ...(data.risk.overallRating ? {} : { overallRating: preview.risk.overallRating, tone: preview.risk.tone }), ...(data.risk.totalPoints != null ? {} : preview.risk.totalPoints != null ? { totalPoints: preview.risk.totalPoints } : {}), categories: pick(data.risk.categories, preview.risk.categories) },
    insurance: pick(data.insurance, preview.insurance),
    timeline: pick(data.timeline, preview.timeline),
    contacts: pick(data.contacts, preview.contacts),
    approvedEmails: [...new Map([...preview.approvedEmails, ...data.approvedEmails].map((e) => [e.email, e])).values()],
    emails: [...new Map([...preview.emails, ...data.emails].map((e) => [e.address, e])).values()],
    equipment: { ...preview.equipment, ...data.equipment },
    packet: data.packet.rawStatuses.length > 0 || data.packet.status !== 'NOT_INVITED' ? data.packet : preview.packet.status !== 'NOT_INVITED' ? preview.packet : data.packet,
    monitoring: { monitored: data.monitoring.monitored ?? preview.monitoring.monitored, blocked: data.monitoring.blocked ?? preview.monitoring.blocked },
    fetched: { preview: preview.fetched.preview || data.fetched.preview, data: preview.fetched.data || data.fetched.data },
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface ParsedSearch {
  kind: 'MC' | 'DOT' | 'NAME' | 'EMPTY'
  mcNumber?: string
  dotNumber?: string
  name?: string
}

/**
 * "MC 274623", "mc-274623", "DOT 1234567", "FF123" and bare digits are numbers MCP can look
 * up. A bare number is tried as an MC (the number a broker is usually given); names are
 * searched in our own directory only, because MCP's API has no name search.
 */
export function parseSearch(raw: string): ParsedSearch {
  const q = raw.trim()
  if (!q) return { kind: 'EMPTY' }
  const dot = q.match(/^(?:usdot|dot)[\s#:-]*(\d{1,9})$/i)
  if (dot) return { kind: 'DOT', dotNumber: dot[1] }
  const mc = q.match(/^(?:mc|docket)[\s#:-]*(\d{1,9})$/i) ?? q.match(/^(\d{1,9})$/)
  if (mc) return { kind: 'MC', mcNumber: docketOf(mc[1]) }
  const other = q.match(/^(ff|mx)[\s#:-]*(\d{1,9})$/i)
  if (other) return { kind: 'MC', mcNumber: `${other[1]!.toUpperCase()}${other[2]}` }
  return { kind: 'NAME', name: q }
}

export const refLabel = (ref: { mcNumber?: string; dotNumber?: string }): string =>
  [ref.mcNumber ? `MC ${ref.mcNumber.replace(/^MC/i, '')}` : null, ref.dotNumber ? `DOT ${ref.dotNumber}` : null].filter(Boolean).join(' · ')

// ── Invite e-mail picker ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export interface InviteEmailCheck {
  ok: boolean
  email: string
  /** True when the address is one MCP preloaded for this carrier. */
  approved: boolean
  error?: string
}

/** One recipient, trimmed and lower-cased, valid in shape. `approved` marks MCP's own list. */
export function validateInviteEmail(raw: string, approved: ReadonlyArray<{ email: string }>): InviteEmailCheck {
  const email = raw.trim().toLowerCase()
  if (!email) return { ok: false, email, approved: false, error: 'Pick an approved address or type one.' }
  if (!EMAIL_RE.test(email)) return { ok: false, email, approved: false, error: 'That is not a valid e-mail address.' }
  return { ok: true, email, approved: approved.some((a) => a.email.toLowerCase() === email) }
}

// ── Directory match ──────────────────────────────────────────────────────────

export interface DirectoryCarrierLike {
  id: string
  name?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
  mcpStatus?: string | null
  mcpInvitedAt?: string | null
  mcpInvitedTo?: string | null
}

/** The Carrier row this card is, by MC then DOT then an exact normalised name. Null when it is not in the directory. */
export function matchDirectoryCarrier<T extends DirectoryCarrierLike>(carriers: readonly T[], card: Pick<McpReviewCard, 'identity'>): { carrier: T; by: 'MC' | 'DOT' | 'NAME' } | null {
  const mc = mcKey(card.identity.mcNumber)
  if (mc) {
    const hit = carriers.find((c) => mcKey(c.mcNumber ?? undefined) === mc)
    if (hit) return { carrier: hit, by: 'MC' }
  }
  const dot = dotKey(card.identity.dotNumber)
  if (dot) {
    const hit = carriers.find((c) => dotKey(c.dotNumber ?? undefined) === dot)
    if (hit) return { carrier: hit, by: 'DOT' }
  }
  const name = normalizeName(card.identity.legalName ?? '')
  if (name) {
    const named = carriers.filter((c) => normalizeName(c.name ?? '') === name)
    if (named.length === 1) return { carrier: named[0]!, by: 'NAME' }
  }
  return null
}

/** Directory carriers a typed name could mean (name / DBA contains the text). Capped. */
export function searchDirectory<T extends DirectoryCarrierLike & { dbaName?: string | null }>(carriers: readonly T[], q: string, cap = 8): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return carriers
    .filter((c) => [c.name, c.dbaName, c.mcNumber, c.dotNumber].some((v) => (v ?? '').toLowerCase().includes(needle)))
    .slice(0, cap)
}

// ── Stub fixtures ────────────────────────────────────────────────────────────

/**
 * What STUB mode shows. Raw MCP-shaped bodies, so the same mapper that reads live answers
 * builds the card and a stub can never drift from the real layout. Synthetic: not a real carrier.
 */
const STUB_BODY = (ref: { mcNumber?: string; dotNumber?: string }, nowMs: number): Record<string, unknown> => {
  const year = new Date(nowMs).getUTCFullYear()
  return {
    DotNumber: ref.dotNumber ?? '9000001',
    DocketNumber: ref.mcNumber ?? 'MC900001',
    CompanyName: 'SAMPLE CARRIER LLC (stub fixture)',
    DBAName: 'Sample Carrier',
    Street: '100 Example Way', City: 'Memphis', State: 'TN', ZipCode: '38101', Country: 'US',
    Phone: '555-0100',
    Status: 'ACTIVE', StatusDate: `${year - 3}-04-12T00:00:00`,
    PossibleFraud: 'No', DoubleBrokering: 'No',
    IncidentReports: { TotalIncidentReports: 0, TotalIncidentReportsWithFraud: 0 },
    IsMonitored: false, IsBlocked: false,
    CarrierRating: { HasCompletedPacket: false },
    RiskAssessment: { Overall: 'Moderate', Authority: 'Pass', Insurance: 'Moderate', Safety: 'Pass', Operation: 'Pass', Other: 'Pass' },
    RiskAssessmentDetails: {
      TotalPoints: 450, OverallRating: 'Moderate',
      Authority: { TotalPoints: 0, OverallRating: 'Pass', Infractions: [] },
      Insurance: { TotalPoints: 300, OverallRating: 'Moderate', Infractions: [{ Description: 'Cargo limit below $100,000', Points: 300 }] },
      Safety: { TotalPoints: 0, OverallRating: 'Pass', Infractions: [] },
      Operation: { TotalPoints: 150, OverallRating: 'Pass', Infractions: [{ Description: 'Fewer than 3 power units', Points: 150 }] },
      Other: { TotalPoints: 0, OverallRating: 'Pass', Infractions: [] },
    },
    CertData: { Status: 'OK', Noncoop: false, Certificates: [{ Coverages: [
      { InsurerName: 'Example Mutual', Type: 'Auto Liability', PolicyNumber: 'STUB-AL-1', ExpirationDate: `${year + 1}-06-30T00:00:00`, CoverageLimit: '$1,000,000' },
      { InsurerName: 'Example Mutual', Type: 'Cargo', PolicyNumber: 'STUB-CG-1', ExpirationDate: `${year + 1}-06-30T00:00:00`, CoverageLimit: '$100,000' },
    ] }] },
    Emails: [{ EmailType: 1, Description: 'Dispatch', Email: 'dispatch@sample-carrier.example' }, { EmailType: 2, Description: 'Owner', Email: 'owner@sample-carrier.example' }],
    AssureAdvantage: [{ CarrierDetails: {
      Authority: { authGrantDate: `${year - 3}-04-20T00:00:00`, commonAuthority: 'A', contractAuthority: 'A', brokerAuthority: 'N' },
      Safety: { rating: 'Not Rated', ratingDate: '' },
    } }],
    CarrierOperationalDetail: { TotalPowerUnits: 2, NumberOfTractors: 2, NumberOfVans: 2, CDLEmployedDrivers: 2 },
    CarrierLane: { Tennessee: true, Georgia: true, Alabama: true },
    CarrierCargoHauled: { GeneralFreight: true },
    CarrierMode: { Truckload: true },
  }
}

/** The stub card for a looked-up number: a fixture, clearly marked, nothing called. */
export function stubReviewCard(ref: { mcNumber?: string; dotNumber?: string }, nowMs: number = Date.now()): McpReviewCard {
  const card = buildReviewCard(STUB_BODY(ref, nowMs), ref, 'data', nowMs)!
  return { ...card, source: 'STUB', emails: [], fetched: { preview: true, data: true } }
}
