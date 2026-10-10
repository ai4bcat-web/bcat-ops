import type { Address } from './tms'

export type ColorKey =
  | 'driver-1' | 'driver-2' | 'driver-3' | 'driver-4' | 'driver-5' | 'driver-6'
  | 'driver-7' | 'driver-8' | 'driver-9' | 'driver-10' | 'driver-11' | 'driver-12'
  | 'broker'

export interface Driver {
  id: string
  name: string
  phone: string // stored E.164 (+1XXXXXXXXXX), displayed (XXX) XXX-XXXX
  active: boolean
  type?: 'driver' | 'broker' // default 'driver'
  colorKey?: ColorKey
  notes?: string
  photoKey?: string  // S3 key for driver photo
  photoUrl?: string  // client-side: resolved presigned URL
  assignedTruckId?: string | null
  assignedTrailerId?: string | null   // Equipment.id of the trailer; null = TBD
  /**
   * Which fleet this driver runs in — mirrors DriverPaySetting.payGroup so the two
   * agree, and decides which documents their file requires.
   */
  fleetGroup?: import('./equipment').FleetGroup | null
  // Compliance & profile fields
  email?: string
  cdl?: string           // CDL number e.g. "CDL-A IL-8823901"
  cdlExpiration?: string // YYYY-MM-DD
  medCardExpiration?: string // YYYY-MM-DD
  drugTestDate?: string  // YYYY-MM-DD — last test date
  hireDate?: string      // YYYY-MM-DD
  // DOT onboarding / compliance classification
  driverType?: DriverType | null      // null = Unclassified
  onboardingStatus?: DriverOnboardingStatus | null
  complianceStatus?: ComplianceStatus | null   // cached, updated by scanner
  onboardingTemplateId?: string | null  // phased onboarding template in effect (e.g. Amazon)
  /** Motive user id, set by staff. Never inferred — see src/lib/motiveDriverMatch.ts. */
  motiveDriverId?: number | null
  /** Dedicated dispatcher (staff email) and who covers for them. */
  dispatcherPrimary?: string | null
  dispatcherBackup?: string | null
  /** Force the Ivan paperwork app regardless of fleet (box truck drivers, Zak). */
  ivanApp?: boolean | null
  /** Hours tab on/off; null = by fleet (Ivan local on, everyone else off). */
  timeClock?: boolean | null
  createdAt: string
  updatedAt: string
}

// ── DOT compliance & onboarding ──────────────────────────────────────────────

export type DriverType = 'COMPANY' | 'OWNER_OPERATOR'
export type TruckOwnershipType = 'COMPANY' | 'OWNER_OPERATOR' | 'LEASED'
export type ComplianceStatus = 'COMPLIANT' | 'EXPIRING_SOON' | 'NON_COMPLIANT' | 'UNKNOWN'
export type DriverOnboardingStatus =
  | 'NOT_STARTED' | 'INVITED' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'COMPLETE' | 'ARCHIVED'
export type TruckOnboardingStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE'
export type ComplianceEntityType = 'DRIVER' | 'TRUCK'

export type OnboardingInviteStatus =
  | 'SENT' | 'OPENED' | 'IN_PROGRESS' | 'SUBMITTED' | 'EXPIRED' | 'REVOKED'

export interface OnboardingInvite {
  id: string
  driverId: string
  email: string
  driverType?: DriverType | null
  token: string
  status: OnboardingInviteStatus
  expiresAt: string
  sentAt?: string | null
  openedAt?: string | null
  lastActivityAt?: string | null
  requestCount?: number | null
  createdAt: string
  updatedAt: string
}

export type DriverApplicationStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'

export interface DriverApplicationRecord {
  id: string
  driverId: string
  legalName?: string | null
  dob?: string | null
  ssnLast4?: string | null
  phone?: string | null
  currentAddress?: string | null
  addressHistory?: unknown        // JSON
  cdlNumber?: string | null
  cdlState?: string | null
  cdlClass?: string | null
  endorsements?: string[] | null
  cdlExpiration?: string | null
  priorLicenses?: unknown         // JSON
  employmentHistory?: unknown     // JSON
  accidents?: unknown             // JSON
  violations?: unknown            // JSON
  cdlIssuedAfterFeb2022?: boolean | null
  eldtProviderName?: string | null
  signatureName?: string | null
  signedAt?: string | null
  ipAddress?: string | null
  status: DriverApplicationStatus
  reviewedBy?: string | null
  reviewedAt?: string | null
  rejectionReason?: string | null
  createdAt: string
  updatedAt: string
}

export type ComplianceDocumentStatus =
  | 'PENDING_REVIEW' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'REJECTED' | 'MISSING' | 'WAIVED'
export type DocumentSource = 'DRIVER_PORTAL' | 'INTERNAL'

export interface ComplianceDocument {
  id: string
  entityType: ComplianceEntityType
  entityId: string
  documentType: string
  title: string
  s3Key?: string | null
  issueDate?: string | null
  expirationDate?: string | null
  status: ComplianceDocumentStatus
  uploadedBy: DocumentSource
  rejectionReason?: string | null
  waivedReason?: string | null
  notes?: string | null
  verifiedBy?: string | null
  verifiedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type OnboardingTaskStatus =
  | 'PENDING' | 'AWAITING_DRIVER' | 'PENDING_REVIEW' | 'COMPLETE' | 'WAIVED' | 'NOT_APPLICABLE'

export type OnboardingTaskOwner = 'DRIVER' | 'OFFICE'

export interface OnboardingTask {
  id: string
  entityType: ComplianceEntityType
  entityId: string
  requirementKey: string
  label: string
  category: string
  required: boolean
  requiresDocument: boolean
  requiresExpiration: boolean
  driverVisible: boolean
  driverActionable: boolean
  status: OnboardingTaskStatus
  completedBy?: string | null
  completedAt?: string | null
  complianceDocumentId?: string | null
  sortOrder: number
  // ── Phased-template fields (all optional; legacy tasks read null) ──
  phase?: number | null            // 1-based phase index within the template
  owner?: OnboardingTaskOwner | null   // who is responsible (DRIVER vs OFFICE)
  assignee?: string | null         // specific staff/driver assigned
  dueDate?: string | null          // YYYY-MM-DD
  templateId?: string | null       // OnboardingTemplate.id this task came from
  catalogVersion?: string | null   // CATALOG_VERSION at generation time
  links?: { label: string; url: string }[] | null   // form/policy links shown in the portal
  createdAt: string
  updatedAt: string
}

export type AlertSeverity = 'UPCOMING' | 'URGENT' | 'CRITICAL' | 'EXPIRED'

export interface ComplianceAlert {
  id: string
  entityType: ComplianceEntityType
  entityId: string
  entityName?: string | null
  documentType: string
  documentTitle?: string | null
  complianceDocumentId?: string | null
  expirationDate?: string | null
  severity: AlertSeverity
  acknowledged: boolean
  acknowledgedBy?: string | null
  acknowledgedAt?: string | null
  emailSentAt?: string | null
  resolvedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type EscalationRecipients = 'DRIVER' | 'MANAGER' | 'BOTH'

export interface EscalationRule {
  id: string
  documentType: string
  daysBeforeExpiration: number
  recipients: EscalationRecipients
  templateKey: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface ComplianceSettings {
  id: string
  settingsKey: string
  portalEmailsPaused: boolean
  escalationEmailsPaused: boolean
  managerEmails?: string[] | null
  /** documentTypes hidden from non-admins. Null falls back to DEFAULT_PRIVATE_DOC_TYPES. */
  privateDocumentTypes?: string[] | null
  /** documentType → 'OFFICE' | 'DRIVER'; overrides the catalog default. */
  documentResponsibility?: Record<string, 'OFFICE' | 'DRIVER'> | null
  createdAt: string
  updatedAt: string
}

export interface EscalationEmailLog {
  id: string
  alertId: string
  entityType?: ComplianceEntityType | null
  entityName?: string | null
  documentType?: string | null
  daysBeforeExpiration: number
  templateKey?: string | null
  recipients?: string[] | null
  sentAt: string
  createdAt: string
  updatedAt: string
}

export type ApptType = 'exact' | 'range' | 'fcfs' | 'tbd'

export type StopType = 'pickup' | 'delivery'

// A single stop on a multi-stop load. Canonical scheduling unit (see src/lib/stops.ts).
// Field names mirror the legacy load fields: appt↔pickupAppt, name↔originName, city↔originCity.
export interface Stop {
  id: string                 // stable id; deterministic for legacy synthesis (`${load.id}:pu|de`)
  type: StopType
  name?: string              // facility / shipper / consignee
  city?: string              // e.g. "Chicago, IL"
  locationId?: string | null // Location.id; address below is the booked snapshot, not a live view
  address?: Address | null
  arrivedAt?: string | null  // actual facility events only — never inferred from the appointment
  departedAt?: string | null
  /**
   * When the truck is expected here, set when the driver departs the pickup. 'motive' is
   * computed from the truck's ELD fix (same driver, delivering today); 'appt' means a
   * different driver delivers today or tomorrow and the appointment is the estimate. See
   * src/lib/stopEvents.ts.
   */
  etaAt?: string | null
  etaBasis?: 'motive' | 'appt' | null
  etaUpdatedAt?: string | null
  appt: string               // ISO UTC (or FCFS/TBD date at 00:00)
  apptType?: ApptType        // default 'exact'
  apptEnd?: string           // ISO UTC — end of window (range only)
  driverId: string | null    // ONE driver per stop — subsumes the old split-load concept
  colorKey?: ColorKey | null // per-stop highlight override; falls back to the load's colorKey
  sequence: number           // 0-based order along the route
  // Slack message ts of the #appts-ivan post that asked for this appointment, so a later
  // time change can reply IN that thread instead of starting a new one. Lives here rather
  // than in a column because `stops` is an a.json() field — no schema change, and it
  // travels with the stop it belongs to. Legacy loads (no stops array) have nowhere to
  // keep it, so those post standalone messages.
  apptThreadTs?: string
  /**
   * S3 keys of the booking-proof screenshots for THIS stop's appointment — the E2Open
   * update and the email confirmation. On the stop (not a column) for the same reason
   * as apptThreadTs: stops is a.json(), so no schema change, and the proof travels with
   * the appointment it proves.
   */
  apptProofs?: { request?: string | null; e2open?: string | null; email?: string | null } | null
  /** A booked appointment that has to be RESCHEDULED — set from the appt editor. */
  apptMoveRequested?: boolean
  /** IntakeItem id of the open "move this appt" task, so booking the change closes it. */
  apptMoveTaskId?: string | null
  /**
   * Batory appointment-workflow status (see src/lib/apptStatus.ts). Absent on stops
   * from before the ladder existed — apptWorkflowStatus() grandfathers those.
   */
  apptStatus?: ApptWorkflowStatus | null
  /** CHANGE NEEDED: the date/time Ruben or Ryne wants instead (ISO). */
  apptChangeTo?: string | null
  /** The date/time we ASKED the facility for (ISO) — stamped when a request is sent
   *  or the status is moved to REQUESTED, so the chip can say what was requested. */
  apptRequestedFor?: string | null
  /** Manually cleared from the Appts queue (Ryne/Ruben's per-day Clear) — the row
   *  leaves the working view and stops counting as open, whatever its dates. */
  apptCleared?: boolean
}

export type ApptWorkflowStatus =
  | 'need_request'   // pickup default — Dennis must email the request (12pm rule)
  | 'need_book'      // delivery default — Ruben must pick the time he wants
  | 'requested'      // request email sent (screenshot on file), waiting on confirmation
  | 'confirmed'      // confirmed-email + E2Open screenshots on file
  | 'change_needed'  // Ruben/Ryne want it moved to apptChangeTo — ladder restarts

export interface Load {
  id: string
  aljexId: string
  tmsId: string
  pickupNumber: string
  pickupAppt: string        // ISO UTC — start time (or FCFS date at 00:00)
  pickupApptEnd?: string    // ISO UTC — end of window (range only)
  pickupApptType?: ApptType // default 'exact'
  deliveryAppt: string      // ISO UTC
  deliveryApptEnd?: string  // ISO UTC — end of window (range only)
  deliveryApptType?: ApptType
  originName?: string       // pickup facility / shipper name
  originCity?: string       // e.g. "Chicago, IL"
  destinationName?: string  // delivery facility / consignee name
  destinationCity?: string  // e.g. "Indianapolis, IN"
  pickupDriverId: string | null
  deliveryDriverId: string | null
  readyToInvoice: boolean
  rateConfirmUrl?: string   // presigned URL of the uploaded rate confirmation
  rateConfirmKey?: string   // S3 key of the rate confirmation (rate-confirms/{loadId}/…)
  // Extended fields (nullable — populated as data becomes available)
  truckId?: string | null
  rate?: number | null      // total load revenue in cents
  miles?: number | null     // load distance
  customer?: string | null  // customer/broker name
  customerId?: string | null
  customerApptWorkflow?: 'NONE' | 'BATORY' | null // resolved from Customer at read time; never persisted
  /** ELD oversight — the fleet manager confirmed logs were kept for a run outside the radius. */
  eldLogsReviewedAt?: string | null
  eldLogsReviewedBy?: string | null
  eldLogsNote?: string | null
  colorKey?: ColorKey | null  // load's own color swatch
  daySlot?: number | null     // MANUAL number badge — independent label, no effect on order
  sortOrder?: number | null   // persisted drag-reorder position within a day (hidden; drives sort)
  notes?: string | null       // short free-text notes
  hot?: boolean | null        // urgent/"hot" load — flagged with 🔥 in schedule
  unscheduled?: boolean | null // true = orphan (no firm date) → calendar's Unscheduled lane
  stops?: Stop[] | null       // canonical multi-stop array; legacy pickup*/delivery* are derived mirrors
  createdAt: string
  updatedAt: string
  createdBy: string
  updatedBy: string
}

export type EntityType = 'Driver' | 'Load'
export type AuditAction = 'create' | 'update' | 'delete'

export interface AuditLogEntry {
  id: string
  entityType: EntityType
  entityId: string
  action: AuditAction
  user: string
  changes: Record<string, { from: unknown; to: unknown }>
  createdAt: string
}

export type ViewMode = 'day' | 'week' | 'month'

// ── Intake queue ─────────────────────────────────────────────────────────────

export type IntakeSource = 'IVAN_CARTAGE' | 'BCAT_LOGISTICS'
export type IntakeStatus = 'NEW' | 'IN_PROGRESS' | 'BUILT' | 'DONE' | 'ARCHIVED'
export type ExternalSource = 'gmail' | 'slack'

export interface IntakeItem {
  id: string
  source: IntakeSource
  status: IntakeStatus
  assignedTo: string
  receivedAt: string
  fromEmail: string
  subject: string
  bodyText: string
  bodyHtml: string
  s3KeyPdfAttachments: string[]
  externalSource?: ExternalSource | null
  externalId?: string | null        // dedup key: "channelId:ts" or gmailMessageId
  externalUrl?: string | null       // Slack permalink or Gmail link
  slackChannelId?: string | null
  slackMessageTs?: string | null
  gmailMessageId?: string | null    // legacy
  extractedMetadata?: Record<string, unknown> | null
  builtLoadId?: string | null
  proNumber?: string | null
  notes?: string | null
  /** Set once the reconciler has replied in this item's thread — never replied twice. */
  slackRepliedAt?: string | null
  /* The last thing said in the Slack thread, cached by intake-reconcile. */
  lastReplyText?: string | null
  lastReplyAt?: string | null
  lastReplyUser?: string | null
  replyCount?: number | null
  threadSyncedAt?: string | null
  createdAt: string
  updatedAt: string
}

// ── Factoring queue ───────────────────────────────────────────────────────────


/** ARCHIVED is out of the working queue but not destroyed — see the FactoringPage filter. */
/**
 * MANUAL_INVOICE: OTR will not buy this broker (or somebody chose to bill it direct), so
 * the invoice goes out by hand — see src/lib/manualInvoice.ts for the steps.
 * INVOICED_MANUALLY: every step done; the invoice is with the broker's AP.
 */
export type FactoringItemStatus =
  | 'NEED_TO_FACTOR' | 'PENDING_WITH_OTR' | 'FACTORED' | 'ARCHIVED'
  | 'MANUAL_INVOICE' | 'INVOICED_MANUALLY'

/** OTR's own invoice statuses, mirrored onto the row so the queue shows their board. */
export type OtrInvoiceStatus =
  | 'Pending'
  | 'Advance Pending'
  | 'Advance Paid'
  | 'Approved'
  | 'Client Request'
  | 'Duplicate'
  | 'OTR Follow-Up'
  | 'Paid'

export type BrokerCheckResult = 'APPROVED' | 'CALL_OFFICE' | 'NOT_APPROVED' | 'UNKNOWN' | 'NOT_FOUND' | 'NO_BUY'

export interface ManualStepMark { at: string; by: string }
export interface ManualInvoiceSteps {
  billToUpdated?: ManualStepMark | null
  pdfExported?: ManualStepMark | null
  emailed?: ManualStepMark | null
}

export interface FactoringItem {
  /** Stable identifier — the literal PRO number, preserving leading zeroes. */
  id: string
  proNumber: string
  status: FactoringItemStatus
  subject: string
  fromEmail: string
  receivedAt: string
  messageId: string
  createdAt: string
  updatedAt: string

  // ── OTR Solutions factoring ───────────────────────────────────────────────
  /** Load this PRO resolves to (Load.aljexId === proNumber, trimmed). */
  loadId?: string | null
  /** Human-entered field overrides; Partial<Record<OtrRequiredField, string>>. */
  otrManualFields?: Record<string, string> | null
  /** Cached readiness from assembleOtrInvoice — what's filled and what's missing. */
  otrReadiness?: unknown | null
  brokerMcChecked?: string | null
  brokerCheckResult?: BrokerCheckResult | null
  brokerCheckedAt?: string | null
  /** OTR's invoice identifier; required for document upload and status reads. */
  otrInvoiceId?: string | null
  otrSubmittedAt?: string | null
  otrSubmittedBy?: string | null
  /** OTR's current status for the invoice, synced from their board. */
  otrStatus?: OtrInvoiceStatus | string | null
  otrScheduleId?: string | null
  /** Amount submitted, in cents. */
  otrAmount?: number | null
  otrStatusSyncedAt?: string | null
  otrDocsUploaded?: { pod?: string; rateConfirmation?: string } | null
  otrError?: string | null
  /** The broker this row bills, once an MC named it. */
  customerId?: string | null
  // ── Invoicing by hand (status MANUAL_INVOICE / INVOICED_MANUALLY) ─────────
  /** Why it left the OTR queue: OTR's No Buy, or a person's choice. */
  manualReason?: 'NO_BUY' | 'MANUAL' | null
  /** Which of the manual steps are done, by whom and when. See src/lib/manualInvoice.ts. */
  manualSteps?: ManualInvoiceSteps | null
  /** The broker's accounts-payable address the invoice goes to. */
  apEmail?: string | null
  manualInvoicedAt?: string | null
}



/** One stretch of an employee driver's day. See src/lib/timeClock.ts for the arithmetic. */
export interface TimeClockEntry {
  id: string
  driverId: string
  /** Chicago calendar day, YYYY-MM-DD. */
  workDate: string
  kind: 'WORK' | 'HOLIDAY' | 'PTO'
  clockInAt?: string | null
  clockOutAt?: string | null
  minutes?: number | null
  note?: string | null
  source?: 'DRIVER' | 'STAFF' | null
  /** Staff email. Set only on a corrected row. */
  correctedBy?: string | null
  correctedAt?: string | null
  /** What the row said before the FIRST correction. */
  originalMinutes?: number | null
  createdAt?: string
  updatedAt?: string
}
