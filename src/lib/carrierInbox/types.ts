/**
 * Step AL — Carrier Sales inbound offers hub: shared contracts.
 *
 * Pure types and constants, relative imports only: the Lambdas bundle `src/lib` by relative
 * path (the `src/lib/spot` precedent) and the browser imports `@/lib/carrierInbox/types`.
 * Every AL slice codes against this file; the pure functions that produce these shapes live
 * beside it (`normalize`, `refs`, `prefilter`, `match`, `settings`).
 *
 * "CarrierOffer" is not a model: a filed offer is a `Quote` row with `side:'BUY'`. These
 * shapes ride two existing models: `ShipmentMessage.offer` (InboundOfferRecord) and the
 * `SpotSettings` row id='carrier-sales' (`carrierInbox`, `carrierInboxState`).
 *
 * Anthropic structured output must be union-free: the model-side schema (in the spot
 * Lambda's `carrierInbox/model.ts`) uses plain string/number with ''/-1 sentinels, and
 * `InboundExtraction` below is what is left AFTER the sentinels are mapped to null.
 */
import type { SpotEquipmentCode } from '../../types/tms'

// ── Extraction ───────────────────────────────────────────────────────────────

/** `NOT_RELEVANT` is never stored. */
export type InboundKind = 'OFFER' | 'INTEREST' | 'WITHDRAW' | 'NOT_RELEVANT'
export type InboundSource = 'EMAIL' | 'CALL'
export type InboundConfidence = 'high' | 'medium' | 'low'
/** Deterministic, computed after the model — never trusted from it. */
export type InboundFlag =
  | 'NO_MC' | 'MC_NAME_MISMATCH' | 'SENDER_UNVERIFIED' | 'FREEMAIL_SENDER' | 'BOARD_RELAY'
  | 'RATE_INVALID' | 'RATE_OUTLIER' | 'NO_LOAD_REF'

export interface InboundCarrier {
  name: string | null
  /** Digits only: "MC-123456" -> "123456". */
  mc: string | null
  dot: string | null
  contactName: string | null
  email: string | null
  /** E.164 when it parses. */
  phone: string | null
}

export interface InboundPlace { city: string | null; state: string | null }

export interface InboundExtraction {
  kind: InboundKind
  confidence: InboundConfidence
  /** <= 200 chars. */
  reason: string
  /** `normalizePro()` output, deduped, <= 5. UNVALIDATED until the router resolves them. */
  loadRefs: string[]
  /** As printed (DAT/Truckstop reference), <= 60. */
  postingRef: string | null
  origin: InboundPlace | null
  destination: InboundPlace | null
  /** YYYY-MM-DD, resolved against the mail's Date header / call date. */
  pickupDate: string | null
  equipment: SpotEquipmentCode | null
  /** Whole dollars as cents; valid 50..25_000 dollars, else null + RATE_INVALID. */
  rateCents: number | null
  ratePerMileCents: number | null
  /** Free text, <= 80. */
  availableAt: string | null
  trucks: number | null
  carrier: InboundCarrier
  /** <= 300, URLs stripped, never copied into any outgoing message. */
  notes: string | null
  /** Field keys the model flagged (TENDER_FILL_SCHEMA convention). */
  lowConfidence: string[]
  flags: InboundFlag[]
}

// ── Matching ─────────────────────────────────────────────────────────────────

export type MatchHow =
  | 'PLUS_ADDRESS' | 'REPLY_THREAD' | 'LOAD_REF_SUBJECT' | 'LOAD_REF_BODY' | 'POSTING_REF' | 'LANE_DATE' | 'NONE'

export interface MatchSignal { key: string; points: number; detail: string }

export interface MatchCandidate {
  shipmentId: string
  shipmentNumber: string | null
  loadId: string
  postingId: string | null
  score: number
  how: MatchHow
  signals: MatchSignal[]
  laneText: string
  pickupAppt: string | null
  covered: boolean
}

export type FileOutcome = 'FILED' | 'THREAD_ONLY' | 'COVERED_LATE' | 'SUGGESTED' | 'UNMATCHED' | 'DUPLICATE'

export type InboundMatchState = 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'COVERED_LATE' | 'ASSIGNED'

export interface InboundCallInfo {
  callSid: string
  durationSec: number | null
  outcome: string | null
  recordingUrl: string | null
}

/** `ShipmentMessage.offer`. Null on every other message. */
export interface InboundOfferRecord {
  source: InboundSource
  mailboxId: string | null
  boardProvider: string | null
  extraction: InboundExtraction
  /** `candidates` <= 3. */
  match: { state: InboundMatchState; how: MatchHow; score: number; top: MatchCandidate | null; candidates: MatchCandidate[] }
  quoteId: string | null
  quoteNumber: string | null
  call: InboundCallInfo | null
  /** Chips AUTO/LOW/MISSING/CONFIRMED/INVALID via the AB `fieldStatusOf`. */
  fieldMeta: Record<string, { source: 'MODEL' | 'HEADER' | 'DIRECTORY' | 'REP'; confidence: 'high' | 'low' }>
  assignedBy: string | null
  assignedAt: string | null
}

// ── Listener -> router hand-over ─────────────────────────────────────────────

/** `FILE_INBOUND_OFFER` input (system caller 'carrier-inbox' only). The mail body is the only free text. */
export interface FileInboundOfferInput {
  source: InboundSource
  /** sha1-20 of (Message-ID header | gmail id | CallSid); the dedupe key. */
  sourceKey: string
  mailboxId: string | null
  boardProvider: string | null
  receivedAt: string
  fromEmail: string | null
  fromName: string | null
  to: string[]
  cc: string[]
  subject: string | null
  body: string
  messageId: string | null
  inReplyTo: string | null
  attachments: { name: string; contentType: string; sizeBytes: number }[]
  /** SPF/DKIM aligned with the From domain (Authentication-Results). */
  authOk: boolean
  extraction: InboundExtraction
  call?: InboundCallInfo
}

export interface FileInboundOfferResult {
  outcome: FileOutcome
  messageId: string
  shipmentId: string | null
  quoteId: string | null
  score: number
  how: MatchHow
}

/** Router (`tmsShipmentActions`) human actions on the Unmatched bucket. */
export interface AssignInboundOfferInput {
  messageId: string
  shipmentId: string
  carrierName?: string
  carrierMc?: string
  amountCents?: number
  equipmentType?: string
  contactName?: string
  contactPhone?: string
}
export interface DismissInboundOfferInput { messageId: string; reason?: string }

/** Sentinel `ShipmentMessage.shipmentId` of the Unmatched bucket. */
export const UNMATCHED_SHIPMENT_ID = 'UNMATCHED'
/** Sentinel `ShipmentMessage.threadKey` of the Unmatched bucket. */
export const UNMATCHED_THREAD_KEY = 'offers+unmatched'
/** `SpotSettings` row id that holds the carrier inbox config and state. */
export const CARRIER_INBOX_SETTINGS_ID = 'carrier-sales'
/** `FileInboundOfferInput.systemCaller` value (`event.systemCaller` on the router). */
export const CARRIER_INBOX_SYSTEM_CALLER = 'carrier-inbox'

// ── Settings row (SpotSettings id='carrier-sales') ───────────────────────────

export type CarrierInboxMailboxMode = 'GOOGLE' | 'SIMULATED'

export interface CarrierInboxMailbox {
  /** 'm1'… */
  id: string
  label: string
  /** The Google account to connect, lower-case. */
  account: string
  /** Distribution addresses this mailbox receives for (<= 10). */
  addresses: string[]
  /** Optional Gmail label to restrict to (the fallback when forwarding hides the address). */
  gmailLabel: string | null
  mode: CarrierInboxMailboxMode
  paused: boolean
}

export interface CarrierInboxVoiceConfig {
  enabled: boolean
  /** sha256 hex only; written only by `CS_VOICE_ROTATE_SECRET`. */
  secretHash: string | null
  rotatedAt: string | null
  maxTranscriptChars: number
}

/** `SpotSettings.carrierInbox` (CAS on `version`). Nothing secret: the row is `authenticated`-readable. */
export interface CarrierInboxConfig {
  enabled: boolean
  /** <= 5. */
  mailboxes: CarrierInboxMailbox[]
  lookbackHours: number
  maxMessagesPerRun: number
  modelCallsPerDay: number
  autoFileMinScore: number
  suggestMinScore: number
  unmatchedRetentionDays: number
  ignoreSenders: string[]
  boardSenderDomains: string[]
  voice: CarrierInboxVoiceConfig
  version: number
}
/** `resolveCarrierInboxConfig` output: every default filled in. Same shape. */
export type ResolvedCarrierInboxConfig = CarrierInboxConfig

export type CarrierInboxMailboxStatus =
  | 'NOT_CONNECTED' | 'PENDING' | 'CONNECTED' | 'NEEDS_RECONNECT' | 'SIMULATED' | 'PAUSED'

/** Per-run counters. Numbers only — never message content. */
export interface CarrierInboxRunStats {
  listed: number; wrongMailbox: number; stage1Rejected: number; stage2Rejected: number
  modelCalls: number; notOffer: number
  filed: number; threadOnly: number; coveredLate: number; suggested: number; unmatched: number; duplicate: number
  errors: number; abandoned: number; held: number; deferred: number
}

export interface CarrierInboxMailboxState {
  status: CarrierInboxMailboxStatus
  googleEmail: string | null
  connectedAt: string | null
  scopes: string[]
  historyId: string | null
  lastPollAt: string | null
  lastPollOk: boolean | null
  lastError: string | null
  /** Consecutive runs the cursor was held for an errored message (MAX_HELD_RUNS = 3). */
  held: number
  /** Poll lock; stale after 4 minutes. */
  runningAt: string | null
  /** sha256 of the OAuth state and its expiry — never the plaintext. */
  pendingStateHash: string | null
  pendingStateExp: string | null
  lastStats: CarrierInboxRunStats | null
}

export interface CarrierInboxRunDigest {
  at: string
  trigger: 'SCHEDULE' | 'MANUAL'
  mailboxId: string | null
  ok: boolean
  elapsedMs: number
  /** Why nothing was read (disabled, model off, budget …), else null. */
  skipped: string | null
  stats: CarrierInboxRunStats | null
  error: string | null
}

/** `SpotSettings.carrierInboxState`: machine-written by the poller only (`UpdateItem SET`). */
export interface CarrierInboxState {
  mailboxes: Record<string, CarrierInboxMailboxState>
  modelCallsDay: string | null
  modelCallsToday: number
  voice: { lastCallAt: string | null; calls24h: number; lastError: string | null; urlSeenAt: string | null; url: string | null }
  /** <= 14, newest first. */
  runs: CarrierInboxRunDigest[]
}

// ── tmsSpotActions: the CS_ family ───────────────────────────────────────────

export const CS_ACTIONS = [
  'CS_STATUS', 'CS_SAVE_SETTINGS', 'CS_POLL_NOW', 'CS_OAUTH_START', 'CS_OAUTH_FINISH', 'CS_DISCONNECT', 'CS_SET_PAUSED',
  'CS_VOICE_ROTATE_SECRET', 'CS_CONNECT_SIMULATED', 'CS_SIM_INJECT_MAIL', 'CS_SIM_INJECT_CALL', 'CS_SIM_RESET', 'CS_SIM_PURGE_TEST',
] as const
export type CsAction = (typeof CS_ACTIONS)[number]

/** tmsShipmentActions: 'FILE_INBOUND_OFFER' (system caller 'carrier-inbox' only), humans: the next two. */
export const INBOUND_OFFER_ROUTER_ACTIONS = ['FILE_INBOUND_OFFER', 'ASSIGN_INBOUND_OFFER', 'DISMISS_INBOUND_OFFER'] as const
export type InboundOfferRouterAction = (typeof INBOUND_OFFER_ROUTER_ACTIONS)[number]
