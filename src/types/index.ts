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
  driverType?: string    // 'company' | 'owner_op'
  createdAt: string
  updatedAt: string
}

export type ApptType = 'exact' | 'range' | 'fcfs' | 'tbd'

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
  daySlot?: number | null     // display order badge 1-5 within pickup day
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

export type ViewMode = 'day' | 'week' | 'compact' | 'planner' | 'two-week' | 'month'

// ── Intake queue ───────────────────────────────────────────────────────────

export type IntakeSource = 'IVAN_CARTAGE' | 'BCAT_LOGISTICS'
export type IntakeStatus = 'NEED_TO_BUILD' | 'BUILT'

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
  gmailMessageId: string
  extractedMetadata?: Record<string, unknown> | null
  builtLoadId?: string | null
  notes?: string | null
  createdAt: string
  updatedAt: string
}
