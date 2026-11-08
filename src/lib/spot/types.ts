/**
 * Step AB — the spot-quoter contract (§9). Pure types and constants; no runtime
 * dependencies, so the Lambdas bundle it by relative path and the browser imports it
 * through `@/lib/spot/types`.
 *
 * Row shapes (`SpotRequestRecord`, `SpotExtraction`, `GmailConnectionRecord`, …) are in
 * `src/types/tms.ts`; the Gmail wire interface is in `./port`.
 */
import type {
  GmailConnectionRecord,
  GmailRepSettings,
  SpotAutoDecision,
  SpotExtraction,
  SpotFieldMeta,
  SpotPollStats,
  SpotRequestRecord,
  SpotRequestStatus,
  SpotSettingsRecord,
  SpotStop,
  SpotEquipmentCode,
  SpotRequestMode,
  SpotFieldMetaEntry,
  SpotFieldSource,
  SpotFieldConfidence,
  SpotMatchHow,
  SpotSentVia,
  SpotReplyIntent,
  SpotThreadEntry,
  SpotClassification,
  SpotMatchCandidate,
  GmailConnectionMode,
  GmailConnectionStatus,
} from '../../types/tms'

export type {
  GmailConnectionRecord,
  GmailRepSettings,
  SpotAutoDecision,
  SpotExtraction,
  SpotFieldMeta,
  SpotPollStats,
  SpotRequestRecord,
  SpotRequestStatus,
  SpotSettingsRecord,
  SpotStop,
  SpotEquipmentCode,
  SpotRequestMode,
  SpotFieldMetaEntry,
  SpotFieldSource,
  SpotFieldConfidence,
  SpotMatchHow,
  SpotSentVia,
  SpotReplyIntent,
  SpotThreadEntry,
  SpotClassification,
  SpotMatchCandidate,
  GmailConnectionMode,
  GmailConnectionStatus,
}

// ── Field chips (§3.3) — Intake's five-state vocabulary ─────────────────────
export type SpotFieldStatus = 'AUTO' | 'LOW' | 'MISSING' | 'CONFIRMED' | 'INVALID'

// ── Pricing (§4.2) ───────────────────────────────────────────────────────────
export type SpotPriceBasis = 'DAT_LIVE' | 'HISTORY' | 'STUB'
export type SpotSuggestionConfidence = 'GOOD' | 'THIN' | 'STUB'

export interface SpotSuggestion {
  basis: SpotPriceBasis
  /** Same meaning as `RateViewAnswer.stub`: no market call was made. */
  stub: boolean
  /** The suggested sell rate, whole dollars expressed in cents. */
  suggestedCents: number
  lowCents: number | null
  avgCents: number | null
  highCents: number | null
  perMileCents: number | null
  reports: number | null
  days: number | null
  targetBps: number
  floorBps: number
  targetSource: string
  floorSellCents: number
  marginAtSuggested: number | null
  belowFloor: boolean
  miles: number | null
  sampleCount: number
  confidence: SpotSuggestionConfidence
  notes: string[]
  /** Label shown on the card, e.g. "Lane history · 7 loads · EXACT". */
  label: string
}

// ── tmsSpotActions (§9.1) ────────────────────────────────────────────────────
export type SpotActionName =
  | 'SPOT_STATUS'
  | 'SPOT_OAUTH_START'
  | 'SPOT_OAUTH_FINISH'
  | 'SPOT_CONNECT_SIMULATED'
  | 'SPOT_DISCONNECT'
  | 'SPOT_SET_PAUSED'
  | 'SPOT_PURGE_MINE'
  | 'SPOT_SAVE_MY_SETTINGS'
  | 'SPOT_POLL_NOW'
  | 'SPOT_LIST_REQUESTS'
  | 'SPOT_GET_REQUEST'
  | 'SPOT_COUNT'
  | 'SPOT_ADD_MANUAL'
  | 'SPOT_UPDATE_FIELDS'
  | 'SPOT_SET_CUSTOMER'
  | 'SPOT_SUGGEST_RESPONSE'
  | 'SPOT_LOG_COPIED'
  | 'SPOT_MARK_SENT'
  | 'SPOT_DISMISS'
  | 'SPOT_MARK_OUTCOME'
  | 'SPOT_SAVE_SETTINGS'
  | 'SPOT_ADMIN_DISCONNECT'
  | 'SPOT_SIM_INJECT'
  | 'SPOT_SIM_RESET'
  | 'SPOT_SIM_PURGE_TEST'

/** `GmailConnectionRecord` as the browser receives it: pending-state fields removed. */
export type SpotConnectionView = Omit<GmailConnectionRecord, 'pendingState' | 'pendingStateExp'>

export type SpotProviderMode = 'STUB' | 'LIVE'

export interface SpotStatusView {
  devStack: boolean
  gmailProvider: { mode: SpotProviderMode; health: string | null }
  datProvider: { mode: SpotProviderMode }
  connection: SpotConnectionView | null
  settings: SpotSettingsRecord
}

/** A list row: the record minus the body. */
export type SpotRequestRow = Omit<SpotRequestRecord, 'bodyText'>

export interface SpotGetRequestResult {
  request: SpotRequestRecord
}

export interface SpotCountView {
  new: number
  needsInfo: number
  needsAttention: number
}

/** The reply the rep may copy: rendered from validated fields only. The app never sends it. */
export interface SpotSuggestedResponse {
  to: string
  subject: string
  body: string
  /** `mailto:` link with recipient, subject and body prefilled. */
  mailto: string
  /** Gmail compose URL (web) with recipient, subject and body prefilled. */
  gmailUrl: string
  rateCents: number
  /** False when no quote exists yet, so the text carries no accept link. */
  hasLink: boolean
}

/** input → output for every action; the typed helpers in apiClient read this. */
export interface SpotActionMap {
  SPOT_STATUS: { input: Record<string, never>; output: SpotStatusView }
  SPOT_OAUTH_START: { input: { redirectUri: string }; output: { url: string } }
  SPOT_OAUTH_FINISH: {
    input: { code: string; state: string; redirectUri: string }
    output: { connection: SpotConnectionView }
  }
  SPOT_CONNECT_SIMULATED: { input: Record<string, never>; output: { connection: SpotConnectionView } }
  SPOT_DISCONNECT: { input: { purge?: boolean }; output: { connection: SpotConnectionView } }
  SPOT_SET_PAUSED: { input: { paused: boolean }; output: { connection: SpotConnectionView } }
  SPOT_PURGE_MINE: { input: Record<string, never>; output: { deleted: number } }
  SPOT_SAVE_MY_SETTINGS: {
    input: { settings: Partial<GmailRepSettings>; expectedVersion?: number }
    output: { connection: SpotConnectionView }
  }
  SPOT_POLL_NOW: {
    input: { userId?: string; all?: boolean }
    output: { stats: SpotPollStats }
  }
  SPOT_LIST_REQUESTS: {
    input: { status?: SpotRequestStatus; userId?: string; cursor?: string | null }
    output: { rows: SpotRequestRow[]; cursor: string | null }
  }
  SPOT_GET_REQUEST: { input: { id: string }; output: SpotGetRequestResult | null }
  SPOT_COUNT: { input: { userId?: string }; output: SpotCountView }
  SPOT_ADD_MANUAL: {
    input: { text: string; subject?: string; fromEmail?: string; fromName?: string }
    output: { request: SpotRequestRecord }
  }
  SPOT_UPDATE_FIELDS: {
    input: { requestId: string; patch: Partial<SpotExtraction>; expectedVersion: number }
    output: { request: SpotRequestRecord }
  }
  SPOT_SET_CUSTOMER: {
    input: { requestId: string; customerId: string; contactName?: string }
    output: { request: SpotRequestRecord }
  }
  SPOT_SUGGEST_RESPONSE: {
    input: { requestId: string; quoteId?: string; intro?: string; outro?: string }
    output: SpotSuggestedResponse
  }
  SPOT_LOG_COPIED: { input: { requestId: string; quoteId?: string }; output: { request: SpotRequestRecord } }
  SPOT_MARK_SENT: { input: { requestId: string }; output: { request: SpotRequestRecord } }
  SPOT_DISMISS: { input: { requestId: string; reason?: string }; output: { request: SpotRequestRecord } }
  SPOT_MARK_OUTCOME: {
    input: { requestId: string; outcome?: 'WON' | 'LOST'; lostReason?: string }
    output: { request: SpotRequestRecord }
  }
  SPOT_SAVE_SETTINGS: {
    input: { settings: Partial<SpotSettingsRecord>; expectedVersion?: number }
    output: { settings: SpotSettingsRecord }
  }
  SPOT_ADMIN_DISCONNECT: { input: { userId: string; purge?: boolean }; output: { connection: SpotConnectionView } }
  SPOT_SIM_INJECT: {
    input: { fixtureId?: string; message?: Record<string, unknown> }
    output: { id: string }
  }
  SPOT_SIM_RESET: { input: Record<string, never>; output: { deleted: number } }
  SPOT_SIM_PURGE_TEST: { input: Record<string, never>; output: { deleted: number } }
}

