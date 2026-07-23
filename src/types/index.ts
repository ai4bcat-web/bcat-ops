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
  appt: string               // ISO UTC (or FCFS/TBD date at 00:00)
  apptType?: ApptType        // default 'exact'
  apptEnd?: string           // ISO UTC — end of window (range only)
  driverId: string | null    // ONE driver per stop — subsumes the old split-load concept
  colorKey?: ColorKey | null // per-stop highlight override; falls back to the load's colorKey
  sequence: number           // 0-based order along the route
}

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
  rateConfirmUrl?: string   // base64 data URL of rate confirmation image
  // Extended fields (nullable — populated as data becomes available)
  truckId?: string | null
  rate?: number | null      // total load revenue in cents
  miles?: number | null     // load distance
  customer?: string | null  // customer/broker name
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

// ── Intake queue ───────────────────────────────────────────────────────────

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
  createdAt: string
  updatedAt: string
}
