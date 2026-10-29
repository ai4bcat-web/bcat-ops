/**
 * Pure coverage logic for the Dispatch workstation.
 *
 * - `coverageStateOf` turns a shipment's active assignment into one of the four
 *   coverage chips the queue prints.
 * - `suggestCarriers` ranks carriers that have run a given lane by load count and
 *   demotes carriers with compliance flags (blocked status, lapsed insurance,
 *   failed vetting portals, etc.).
 *
 * These functions know nothing about React or the API, so they are tested
 * directly and cheaply.
 */
import type {
  AssignmentType,
  CarrierDoNotUseReason,
  CarrierInactiveReason,
  CarrierRecord,
  InsurancePolicy,
  LoadWorkflowStatus,
  RateConStatus,
} from '@/types/tms'

export type CoverageState = 'NEEDS_COVERAGE' | 'COVERED' | 'RATE_CON_SIGNED' | 'DISPATCHED'

export interface ActiveLegSummary {
  assignmentType?: AssignmentType | null
  loadStatus?: LoadWorkflowStatus | null
  carrierId?: string | null
  dispatchedAt?: string | null
  rateConSignedAt?: string | null
}

export function coverageStateOf(summary: ActiveLegSummary): CoverageState {
  if (!summary.assignmentType) return 'NEEDS_COVERAGE'
  if (summary.dispatchedAt || summary.loadStatus === 'DISPATCHED') return 'DISPATCHED'
  if (summary.rateConSignedAt) return 'RATE_CON_SIGNED'
  return 'COVERED'
}

export interface LaneHistoryEntry {
  carrierId: string
  originState: string
  destinationState: string
  /** Cents paid to the carrier on that load, zero when unknown. */
  rateCents: number
  bookedAt: string
}

export interface SuggestedCarrier {
  carrier: CarrierRecord
  loadsOnLane: number
  lastRateCents: number | null
  lastLoadAt: string | null
  flags: string[]
  /** True when the carrier has no compliance flags and its directory status is ACTIVE. */
  clean: boolean
}

export interface SuggestCarriersOptions {
  originState: string
  destinationState: string
  carriers: readonly CarrierRecord[]
  history: readonly LaneHistoryEntry[]
  now?: Date
}

const DO_NOT_USE_LABELS: Record<CarrierDoNotUseReason, string> = {
  DOUBLE_BROKERING: 'double brokering',
  CARGO_CLAIM: 'cargo claim',
  THEFT: 'theft',
  FRAUD: 'fraud',
  SUSPICIOUS_ACTIVITY: 'suspicious activity',
}

const INACTIVE_LABELS: Record<CarrierInactiveReason, string> = {
  EXPIRED_INSURANCE: 'expired insurance',
  INACTIVE_AUTHORITY: 'inactive authority',
  INACTIVE_AGREEMENT: 'inactive agreement',
  SAFETY_ISSUES: 'safety issues',
  OTHER: 'other',
}

function laneKey(originState: string, destinationState: string): string {
  return `${originState.trim().toUpperCase()}->${destinationState.trim().toUpperCase()}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function insuranceFlag(policy: InsurancePolicy | undefined, typeLabel: string, now: Date): string | null {
  if (!policy?.expiresAt) return `${typeLabel} expiry unknown`
  const expires = new Date(policy.expiresAt)
  if (Number.isNaN(expires.getTime())) return `${typeLabel} expiry unknown`
  if (expires < now) return `${typeLabel} expired`
  if (expires < addDays(now, 30)) return `${typeLabel} expiring soon`
  return null
}

export function carrierFlags(carrier: CarrierRecord, now = new Date()): string[] {
  const flags: string[] = []

  if (carrier.status === 'DO_NOT_USE') {
    const why = carrier.statusReason && DO_NOT_USE_LABELS[carrier.statusReason as CarrierDoNotUseReason]
    flags.push(`No-buy${why ? `: ${why}` : ''}`)
  }
  if (carrier.status === 'INACTIVE') {
    const why = carrier.statusReason && INACTIVE_LABELS[carrier.statusReason as CarrierInactiveReason]
    flags.push(`Inactive${why ? ` (${why})` : ''}`)
  }
  if (carrier.status === 'PENDING' || carrier.status === 'REVIEW') {
    flags.push(`Status: ${carrier.status.toLowerCase()}`)
  }

  if (carrier.authorityStatus === 'INACTIVE') flags.push('Authority inactive')
  if (carrier.authorityStatus === 'NONE' || carrier.authorityStatus === 'UNKNOWN') {
    flags.push('Authority not verified')
  }

  if (carrier.safetyRating === 'UNSATISFACTORY') flags.push('Unsatisfactory safety rating')
  if (carrier.safetyRating === 'CONDITIONAL') flags.push('Conditional safety rating')

  const policies = carrier.insurancePolicies ?? []
  const auto = policies.find((p) => p.type === 'AUTO_LIABILITY')
  const cargo = policies.find((p) => p.type === 'CARGO')

  if (!auto && !cargo) {
    flags.push('Insurance missing')
  } else {
    const autoFlag = auto ? insuranceFlag(auto, 'Auto liability', now) : 'Auto liability missing'
    const cargoFlag = cargo ? insuranceFlag(cargo, 'Cargo', now) : 'Cargo insurance missing'
    if (autoFlag) flags.push(autoFlag)
    if (cargoFlag) flags.push(cargoFlag)
  }

  if (carrier.highwayStatus === 'FAIL') flags.push('Highway failed')
  if (carrier.highwayStatus === 'INCOMPLETE') flags.push('Highway incomplete')
  if (carrier.rmisStatus === 'FAIL') flags.push('RMIS failed')
  if (carrier.rmisStatus === 'INCOMPLETE') flags.push('RMIS incomplete')
  if (carrier.mcpStatus && carrier.mcpStatus !== 'PASS' && carrier.mcpStatus !== 'ACTIVE') {
    flags.push(`MyCarrierPackets ${carrier.mcpStatus.toLowerCase()}`)
  }

  return flags
}

export function suggestCarriers({
  originState,
  destinationState,
  carriers,
  history,
  now = new Date(),
}: SuggestCarriersOptions): SuggestedCarrier[] {
  const targetKey = laneKey(originState, destinationState)
  const byCarrier: Record<string, LaneHistoryEntry[]> = {}

  for (const entry of history) {
    if (!entry.carrierId) continue
    if (!entry.originState || !entry.destinationState) continue
    if (laneKey(entry.originState, entry.destinationState) !== targetKey) continue
    const list = (byCarrier[entry.carrierId] ??= [])
    list.push(entry)
  }

  const suggestions: SuggestedCarrier[] = []
  for (const carrier of carriers) {
    const entries = byCarrier[carrier.id]
    if (!entries || entries.length === 0) continue

    const sorted = [...entries].sort((a, b) => b.bookedAt.localeCompare(a.bookedAt))
    const loadsOnLane = sorted.length
    const lastRateCents = sorted[0].rateCents ?? null
    const lastLoadAt = sorted[0].bookedAt ?? null
    const flags = carrierFlags(carrier, now)
    const clean = flags.length === 0 && carrier.status === 'ACTIVE'

    suggestions.push({ carrier, loadsOnLane, lastRateCents, lastLoadAt, flags, clean })
  }

  suggestions.sort((a, b) => {
    const aDemoted = a.clean ? 0 : 1
    const bDemoted = b.clean ? 0 : 1
    if (aDemoted !== bDemoted) return aDemoted - bDemoted

    if (b.loadsOnLane !== a.loadsOnLane) return b.loadsOnLane - a.loadsOnLane

    const aDate = a.lastLoadAt ?? ''
    const bDate = b.lastLoadAt ?? ''
    return bDate.localeCompare(aDate)
  })

  return suggestions
}

export const RATE_CON_STATUS_LABELS: Record<RateConStatus, string> = {
  NOT_SENT: 'Not sent',
  SENT: 'Sent',
  OPENED: 'Opened',
  SIGNED: 'Signed',
  DECLINED: 'Declined',
  VOIDED: 'Voided',
  EXPIRED: 'Expired',
}
