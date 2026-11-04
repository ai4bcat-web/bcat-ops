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

// ── Auto-send (§4.7) ─────────────────────────────────────────────────────────
export const AUTO_SEND_REASONS = [
  'ORG_OFF',
  'REP_OFF',
  'NO_CUSTOMER',
  'MATCH_NOT_EXACT',
  'CUSTOMER_NOT_ACTIVE',
  'NOT_OWNER',
  'CUSTOMER_OPT_OUT',
  'FIELD_NOT_HIGH',
  'MODE_NOT_FTL',
  'ACCESSORIALS',
  'SPECIAL_HANDLING',
  'PRICE_STUB',
  'PRICE_THIN',
  'BELOW_FLOOR',
  'SENDER_AUTH',
  'THREAD_NOT_NEW',
  'NO_RECIPIENT',
  'DUPLICATE',
  'CAP_REP',
  'CAP_CUSTOMER',
  'DEV_STACK',
] as const
export type AutoSendReason = (typeof AUTO_SEND_REASONS)[number]

export interface AutoSendDecision {
  allow: boolean
  reasons: AutoSendReason[]
}

// ── The door: `SPOT_AUTO_QUOTE`, direct invoke of tms-shipment-actions (§9.3) ──
export interface SpotAutoQuoteEvent {
  spotAutoQuote: {
    requestId: string
    repId: string
    customerId: string
    contactEmail: string
    extraction: SpotExtraction
    fieldMeta: SpotFieldMeta
    autoReplyAllowed: true
  }
}

export type SpotAutoQuoteResult =
  | {
      ok: true
      quoteId: string
      quoteNumber: string
      amountCents: number
      expiresAt: string
      link: string
      priceBasis: 'DAT_LIVE' | 'HISTORY'
      stub: false
    }
  | { ok: false; reasons: AutoSendReason[] }

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
  | 'SPOT_CREATE_DRAFT'
  | 'SPOT_SEND_DRAFT'
  | 'SPOT_DISMISS'
  | 'SPOT_MARK_OUTCOME'
  | 'SPOT_SAVE_SETTINGS'
  | 'SPOT_ADMIN_DISCONNECT'
  | 'SPOT_SIM_INJECT'
  | 'SPOT_SIM_MARK_SENT'
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
  /** Fetched from Gmail at the moment of the call; null when there is no draft. */
  draft: { to: string; subject: string; text: string } | null
}

export interface SpotCountView {
  new: number
  needsInfo: number
  needsAttention: number
}

export interface SpotDraftResult {
  draftId: string
  openUrl: string
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
  SPOT_CREATE_DRAFT: {
    input: { requestId: string; quoteId: string; intro?: string; outro?: string }
    output: SpotDraftResult
  }
  SPOT_SEND_DRAFT: {
    input: { requestId: string; confirm: true }
    output: { request: SpotRequestRecord }
  }
  SPOT_DISMISS: { input: { requestId: string; reason?: string }; output: { request: SpotRequestRecord } }
  SPOT_MARK_OUTCOME: { input: { requestId: string }; output: { request: SpotRequestRecord } }
  SPOT_SAVE_SETTINGS: {
    input: { settings: Partial<SpotSettingsRecord>; expectedVersion?: number }
    output: { settings: SpotSettingsRecord }
  }
  SPOT_ADMIN_DISCONNECT: { input: { userId: string; purge?: boolean }; output: { connection: SpotConnectionView } }
  SPOT_SIM_INJECT: {
    input: { fixtureId?: string; message?: Record<string, unknown> }
    output: { id: string }
  }
  SPOT_SIM_MARK_SENT: { input: { draftId: string }; output: { messageId: string } }
  SPOT_SIM_RESET: { input: Record<string, never>; output: { deleted: number } }
  SPOT_SIM_PURGE_TEST: { input: Record<string, never>; output: { deleted: number } }
}

