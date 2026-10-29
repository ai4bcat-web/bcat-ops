// `Stop` lives in ./index, which imports Address and the step-B stop fields from
// here. Type-only in both directions, so the cycle never reaches runtime.
import type { Stop, StopType } from './index'

export interface Address {
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  lat?: number | null
  lng?: number | null
  timezone?: string | null
  geocodeExpiresAt?: string | null
}

export type CustomerStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'QUALIFIED'
  | 'QUOTED'
  | 'NURTURING'
  | 'PENDING'
  | 'ACTIVE'
  | 'DORMANT'
  | 'CLOSED'
  | 'BLOCKED'

export type CustomerContactType =
  | 'PRIMARY'
  | 'BILLING'
  | 'OPERATIONS'
  | 'SALES'
  | 'CLAIMS'
  | 'OTHER'

export type CustomerNotification =
  | 'APPT_SCHEDULED'
  | 'LOADING'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'UNLOADING'
  | 'DELIVERED'
  | 'INVOICE_SENT'

export interface CustomerContact {
  id: string
  name: string
  email?: string | null
  phone?: string | null
  title?: string | null
  types: CustomerContactType[]
  billToId?: string | null
  notifications: CustomerNotification[]
  active: boolean
}

export interface BillToParty {
  id: string
  name: string
  address?: Address | null
  email?: string | null
  phone?: string | null
  paymentTermsDays?: number | null
  isDefault: boolean
}

export type ReferenceLevel = 'ORDER' | 'HANDLING_UNIT' | 'PACKAGE' | 'STOP'

export interface RequiredReference {
  code: string
  label?: string | null
  level: ReferenceLevel
  display: boolean
  countOnNewOrder: number
}

export type ChargeCalc = 'FLAT' | 'PER_MILE' | 'PER_CWT' | 'PERCENT'

/** Org catalog entry. Stored on TmsSettings.chargeCodes. */
export interface ChargeCodeDef {
  code: string
  label: string
  category?: string | null
  calculatedBy: ChargeCalc
  defaultAmountCents?: number | null
}

export interface ChargeCodeOverride {
  code: string
  display: boolean
  customerCode?: string | null
  label?: string | null
  category?: string | null
  calculatedBy?: ChargeCalc | null
  defaultAmountCents?: number | null
}

export interface DefaultCharge {
  code: string
  amountCents: number
  count?: number | null
}

export type PricingMode = 'MARGIN' | 'MARKUP' | 'PROFIT'

export interface PricingDefaults {
  mode: PricingMode
  defaultBps?: number | null
  defaultProfitCents?: number | null
  minProfitCents?: number | null
  maxProfitCents?: number | null
  singleChargeCode?: string | null
  distribution?: string | null
}

export interface QuotingDefaults {
  defaultMode?: string | null
  hoursToQuote?: number | null
  notes?: string | null
  portalLtlDispatchMode?: string | null
  portalStatusMask?: string[] | null
  blockedLtlCarrierIds?: string[] | null
  selfQuoteCarrierIds?: string[] | null
}

export type InvoiceFrequency =
  | 'DAILY'
  | 'TWICE_WEEKLY'
  | 'WEEKLY'
  | 'MONTHLY'

export interface VisibilityPrefs {
  milestoneEmails: boolean
  sharedTrackingLink: boolean
  shipperPortal: boolean
}

export interface CustomerRecord {
  id: string
  name: string
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  notes?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
  /**
   * Whether this customer's loads get factored. Factoring is what makes an MC and
   * origin/destination ZIPs mandatory at booking; a direct-billed customer needs neither.
   * Null means nobody has decided, and is treated as not factored.
   */
  factored?: boolean | null
  billingEmail?: string | null
  billingContactName?: string | null
  billingPhone?: string | null
  billingAddress?: Address | null
  paymentTermsDays?: number | null
  creditLimitCents?: number | null
  creditHoldFlag?: boolean | null
  requiredDocsForInvoice?: string[] | null
  defaultDivisionKey?: string | null
  defaultSalesRepId?: string | null
  aliases?: string[] | null
  normalizedName?: string | null
  active?: boolean | null
  apptWorkflow?: 'NONE' | 'BATORY' | null
  mergedIntoId?: string | null

  // Status ladder
  status?: CustomerStatus | null
  statusReason?: string | null
  statusChangedAt?: string | null
  statusChangedBy?: string | null
  replacementCustomerId?: string | null

  // Account / lead profile
  leadSource?: string | null
  industry?: string | null
  serviceTier?: string | null
  website?: string | null

  // Credit controls (customer overrides; org defaults live on TmsSettings)
  freeCreditRequired?: boolean | null
  creditUsageWarningBps?: number | null
  maxDaysLate?: number | null

  // Billing / communication preferences
  invoiceFrequency?: InvoiceFrequency | null
  visibilityPrefs?: VisibilityPrefs | null
  gpSplitBps?: number | null

  // Structured JSON arrays
  contacts?: CustomerContact[] | null
  billToParties?: BillToParty[] | null
  requiredReferences?: RequiredReference[] | null
  chargeCodeOverrides?: ChargeCodeOverride[] | null
  defaultCharges?: DefaultCharge[] | null
  pricingDefaults?: PricingDefaults | null
  quotingDefaults?: QuotingDefaults | null

  rateConTerms?: string | null
  teamKey?: string | null
  operatedById?: string | null
  accountOwnerIds?: string[] | null

  createdAt: string
  updatedAt: string
}

export interface LocationContact {
  name?: string | null
  role?: string | null
  email?: string | null
  phone?: string | null
}

/** One remark a driver left about a facility from the driver app. */
export interface LocationDriverNote {
  at: string
  driverId: string
  by: string
  text: string
}

export interface LocationRecord extends Address {
  id: string
  name: string
  customerName?: string | null
  apptContactName?: string | null
  apptContactEmail?: string | null
  apptContactPhone?: string | null
  notes?: string | null
  lat?: number | null
  lng?: number | null
  timezone?: string | null
  geohash6?: string | null
  placeId?: string | null
  geocodedAt?: string | null
  geocodeExpiresAt?: string | null
  facilityType?: 'SHIPPER' | 'RECEIVER' | 'BOTH' | 'YARD' | 'TRUCK_STOP' | 'OTHER' | null
  hours?: string | null
  apptRule?: 'FCFS' | 'APPT' | 'EITHER' | null
  apptLeadTimeHours?: number | null
  dockNotes?: string | null
  lumperNotes?: string | null
  detentionNotes?: string | null
  contacts?: LocationContact[] | null
  driverNotes?: LocationDriverNote[] | null
  customerIds?: string[] | null
  aliases?: string[] | null
  normalizedName?: string | null
  normalizedAddress?: string | null
  mergedIntoId?: string | null
  mergeJobId?: string | null
  active?: boolean | null
  createdAt: string
  updatedAt: string
}

export interface Division {
  id: string
  key: string
  name: string
  legalName?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
  scac?: string | null
  remitToName?: string | null
  remitToAddress?: Address | null
  remitToEmail?: string | null
  invoicePrefix?: string | null
  fleetGroup?: 'LOCAL' | 'AMAZON' | 'BOX_TRUCK' | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface TmsSettings {
  id: string
  marginFloorBps?: number | null
  defaultPaymentTermsDays?: number | null
  accessorialCodes?: unknown[] | null
  loadStatusRules?: Record<string, unknown> | null
  invoiceNumberFormat?: string | null
  /** Past days leave the appointment queue's working list on their own. See splitPastAppts. */
  autoClearPastAppts?: boolean | null

  // Org defaults for customer credit controls
  defaultCreditLimitCents?: number | null
  defaultFreeCreditRequired?: boolean | null
  defaultCreditUsageWarningBps?: number | null
  defaultMaxDaysLate?: number | null

  requireCustomerApproval?: boolean | null

  defaultRequiredDocs?: string[] | null
  defaultRequiredReferences?: RequiredReference[] | null
  chargeCodes?: ChargeCodeDef[] | null
  rateConTerms?: string | null

  // Step B — shipment numbering and workflow toggles
  /** Prefix for generated shipment numbers; `nextShipmentNumber` is the atomic counter. */
  shipmentPrefix?: string | null
  nextShipmentNumber?: number | null
  /** Cancel / delete a shipment is an ADMIN-only action when true. */
  cancelDeleteAdminOnly?: boolean | null
  /** Whether the optional AR "Unbilled" and AP "In review" stages are in use. */
  arUnbilledStage?: boolean | null
  apInReviewStage?: boolean | null
  /** Mode a new shipment starts in when the customer has no default. */
  defaultMode?: ShipmentMode | null

  // Step C — carrier approval gates, booking checks and quick pay
  /** Carrier statuses a load may be booked to. Default `['ACTIVE']`. */
  allowedCarrierStatuses?: string[] | null
  /** A new carrier starts PENDING and an admin must approve it before it may be booked. */
  requireCarrierApproval?: boolean | null
  /** Document types a carrier is warned about when missing. Default COI_CARGO/COI_AUTO/W9/CARRIER_AGREEMENT. */
  requiredCarrierDocs?: string[] | null
  /** Load fields booking warns about when blank. See `BookingRequiredField`. */
  bookingRequiredFields?: string[] | null
  /** Payment terms a new carrier starts with. */
  defaultCarrierTermsDays?: number | null
  /** Quick-pay ladder, ascending by days; a longer wait never costs more. */
  quickPayTiers?: QuickPayTier[] | null
  /** How long a sent rate confirmation stays signable. */
  rateConExpiryHours?: number | null
  /** Fields the carrier must fill in before signing. See `RateConRequiredField`. */
  rateConRequiredFields?: string[] | null
  /** How many days ahead an expiring insurance policy starts warning. Default 30. */
  insuranceWarnDays?: number | null

  // Step D — tracking and check calls
  /** Hours to the next check call when nobody picks a time. Default 4. */
  checkCallDefaultIntervalHours?: number | null
  /** How long a due check call has before it counts as overdue. Default 15. */
  checkCallGraceMinutes?: number | null
  checkCallNotifyChannel?: CheckCallNotifyChannel | null
  /** Slack channel the due / overdue notices also post to. */
  checkCallSlackChannelId?: string | null
  /** How long a carrier ping link lives past the last delivery appointment. Default 72. */
  trackingLinkExpiryHours?: number | null
  /** How long a customer tracking link lives. Default 14. */
  customerLinkExpiryDays?: number | null
  /** Whether the customer page names the carrier. Default false. */
  customerLinkShowsCarrier?: boolean | null
  /** Whether the customer page shows the last known position. Default true. */
  customerLinkShowsPosition?: boolean | null
  /** Who the customer page says to call. */
  trackingContact?: TrackingContact | null
  /** Body of the carrier ping text. Must contain `{url}`. */
  trackingSmsTemplate?: string | null

  // Step E — documents and delivery
  /** Master switch for milestone e-mails; a customer still has to opt in. */
  milestoneNoticesEnabled?: boolean | null
  /** Ask the carrier for paperwork automatically when their load delivers. */
  podRequestEnabled?: boolean | null
  /** What a carrier upload link asks for. Default POD + CARRIER_INVOICE. */
  requiredCarrierUploadTypes?: string[] | null
  /** How long an upload link lives past delivery. Default 30. */
  uploadLinkExpiryDays?: number | null
  /** Bodies of the two outgoing e-mails. Both must contain `{url}`. */
  milestoneEmailTemplate?: string | null
  podRequestEmailTemplate?: string | null
  /** Terms printed on every generated bill of lading. */
  bolTerms?: string | null
  /** Voiding a document is an ADMIN-only action when true. Default true. */
  documentDeleteAdminOnly?: boolean | null

  // Step F — AR: invoicing and payments
  /** Taken with an atomic ADD. A failed generation skips a number, never reuses one. */
  nextInvoiceNumber?: number | null
  /** Terms printed at the foot of every invoice. */
  invoiceTerms?: string | null
  /** Body of the invoice e-mail. Must contain `{number}`. */
  invoiceEmailTemplate?: string | null
  /** Attached on top of the customer's required documents. Default POD + BOL. */
  invoiceAttachTypes?: string[] | null
  /** Where a factored customer pays. Printed instead of the division's remit-to. */
  factorRemitTo?: RemitTo | null
  /** Void, payment, credit, write-off and reversal are owner/ADMIN when true. Default true. */
  arPostingAdminOnly?: boolean | null
  /** One e-mail per invoice, or one per customer + bill-to. Default PER_INVOICE. */
  invoiceBatchEmail?: InvoiceBatchEmailMode | null

  // Step G — AP: carrier bills and payments
  /** Only owner/ADMIN may approve a bill when true. Default true. */
  apApprovalAdminOnly?: boolean | null
  /** Payment, credit, reversal and void are owner/ADMIN when true. Default true. */
  apPostingAdminOnly?: boolean | null
  /** An unsigned rate con blocks approval when true. Default true. */
  apRequireSignedRateCon?: boolean | null
  /** Body of the remittance e-mail. Must contain `{reference}`. */
  remittanceEmailTemplate?: string | null
  /** Carrier paperwork a bill needs before approval. Defaults to `requiredCarrierUploadTypes`. */
  apBillDocsRequired?: string[] | null

  // ── Quotes & rates (Step H) ────────────────────────────────────────────────
  /** Hours a customer gets to answer a quote, when the customer has not said. Default 24. */
  hoursToQuote?: number | null
  /** Hours a carrier gets to answer an offer, capped at the first pickup. Default 24. */
  offerExpiryHours?: number | null
  /** `Q{n:6}` — the quote number is the quote's id, so this is read once, at mint. */
  quoteNumberFormat?: string | null
  nextQuoteNumber?: number | null
  /** Each must contain `{link}`: a quote e-mail with no link is not a quote. */
  quoteEmailTemplate?: string | null
  counterEmailTemplate?: string | null
  offerRequestEmailTemplate?: string | null
  quoteTermsText?: string | null
  /** A below-floor or below-min-margin quote needs owner/ADMIN to send. Default true. */
  quoteBelowMinMarginAdminOnly?: boolean | null
  /** Whether the carrier's offer link shows the book-now rate. Default true. */
  quoteOffersCarrierSeesBookNow?: boolean | null

  // ── Roles, teams, commissions (Step I) ─────────────────────────────────────
  /** `Team[]`, the brokerage's teams and their sender addresses. */
  teams?: Team[] | null
  /** Default the "Mine" board filter on for customer reps. A filter, not a boundary. */
  limitCustomerRepView?: boolean | null
  limitCarrierRepView?: boolean | null
  /** Nothing is computed, written or shown until this is on. Default false. */
  commissionsEnabled?: boolean | null
  commissionTrigger?: CommissionTrigger | null
  commissionPlans?: CommissionPlan[] | null
  commissionPaySchedule?: CommissionPaySchedule | null
  /** False — a manager may approve. True — owner/ADMIN only. */
  commissionApprovalAdminOnly?: boolean | null
  /** True — only owner/ADMIN submit, approve or pay a period. */
  commissionPayAdminOnly?: boolean | null

  createdAt?: string
  updatedAt?: string
}

export interface GeocodeResult extends Address {
  lat: number
  lng: number
  timezone: string
  placeId: string
  formattedAddress: string
  geocodedAt: string
  geocodeExpiresAt: string
  geocodeToken: string
}

export interface AutocompleteSuggestion {
  placeId: string
  description: string
}

export interface LocationMergePreview {
  sourceId: string
  targetId: string
  loadCount: number
}

export interface LocationMergeJob {
  id: string
  sourceId: string
  targetId: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PENDING'
  processedCount: number
  remainingCount?: number | null
  error?: string | null
  createdAt?: string
  updatedAt?: string
}

// ── Step B — Shipment · Order · Load ─────────────────────────────────────────
//
// Three records describe one movement: the Shipment is the movement itself and
// carries the single customer-facing status, the Order is the sell side (what the
// customer bought and owes), and the existing Load is the buy side (who hauls a leg
// and what that costs). Money is integer cents, percentages basis points, timestamps
// ISO 8601. Enum values are the wire values AppSync stores; short board labels live
// in src/lib/shipmentStatus.ts.

/** Shipment movement status (spec §6.8). Truckload uses BOOKED→LOADING→UNLOADING;
 *  LTL / forwarding uses PLANNED→PICKED_UP→RECOVERED→OUT_FOR_DELIVERY. */
export type ShipmentStatus =
  | 'DRAFT'
  | 'TENDER_PENDING'
  | 'TENDER_REJECTED'
  | 'OPEN'
  | 'ON_HOLD'
  | 'BOOKED'
  | 'PLANNED'
  | 'DISPATCHED'
  | 'LOADING'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'RECOVERED'
  | 'ARRIVED_AT_DELIVERY_TERMINAL'
  | 'OUT_FOR_DELIVERY'
  | 'UNLOADING'
  | 'DELIVERED'
  | 'CANCELED'

/**
 * Load status: every shipment movement label plus the two the buy side owns —
 * SOURCING (needs a carrier) and INVOICING (delivered, carrier invoice in review).
 * Named `LoadWorkflowStatus` because `LoadStatusId` in src/lib/loadStatus.ts is the
 * *derived* own-fleet status and the two are read side by side on the board.
 */
export type LoadWorkflowStatus =
  | 'SOURCING'
  | 'BOOKED'
  | 'PLANNED'
  | 'DISPATCHED'
  | 'LOADING'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'RECOVERED'
  | 'ARRIVED_AT_DELIVERY_TERMINAL'
  | 'OUT_FOR_DELIVERY'
  | 'UNLOADING'
  | 'DELIVERED'
  | 'INVOICING'
  | 'CANCELED'

export type ShipmentMode =
  | 'FTL'
  | 'PTL'
  | 'BULK'
  | 'DRAYAGE'
  | 'INTERMODAL'
  | 'RLTL'
  | 'LTL'
  | 'AIR'
  | 'OCEAN'
  | 'RAIL'

/** How the shipment came to exist. BACKFILL marks rows minted from legacy loads. */
export type ShipmentSource = 'MANUAL' | 'TENDER' | 'DUPLICATE' | 'BACKFILL'

/**
 * Who moved a load's status last — the driver app and check calls write their own.
 * SYSTEM is load-tracking-projector reflecting a stop time that something other
 * than a person or the driver app stamped (POD close, dispatch MMS auto-POD).
 */
export type LoadStatusSource = 'USER' | 'DRIVER_APP' | 'CHECK_CALL' | 'BACKFILL' | 'SYSTEM'

export type AssignmentType = 'OWN_ASSET' | 'CARRIER' | 'NEED_TO_COVER'

export type TrackingProvider = 'NONE' | 'MANUAL' | 'LINK' | 'DRIVER_APP' | 'MOTIVE'

export type LoadCarrierKind = 'OWN_ASSET' | 'CARRIER'

/** BOUNCED = the carrier fell off and kept nothing; TONU = truck ordered not used, paid. */
export type LoadCarrierStatus = 'ACTIVE' | 'BOUNCED' | 'TONU'

/**
 * LEGACY is an Aljex-era order whose bill went out before this system existed: it is
 * never a worklist row, and its credit exposure falls back to the load rule.
 */
export type ArStatus =
  | 'DOCS_NEEDED'
  | 'UNBILLED'
  | 'UNPAID'
  | 'PAID'
  | 'INVOICE_NOT_NEEDED'
  | 'LEGACY'

export type ApStatus = 'AWAITING_INVOICE' | 'IN_REVIEW' | 'TO_BE_PAID' | 'PAID'

export type RateType = 'SPOT' | 'CONTRACT'

export type ChargeSide = 'CUSTOMER' | 'CARRIER'

export type ReferenceVisibility = 'INTERNAL' | 'CUSTOMER' | 'CARRIER' | 'ALL'

export type HandlingUnit =
  | 'PALLET'
  | 'SKID'
  | 'CRATE'
  | 'BOX'
  | 'DRUM'
  | 'TOTE'
  | 'BUNDLE'
  | 'ROLL'
  | 'OTHER'

/** Who asked for the appointment window on a stop. */
export type ApptRequestedBy = 'CUSTOMER' | 'CARRIER' | 'BROKER'

/**
 * One reference number on an order (PO, BOL, pickup number…). `level` says what it
 * identifies and `visibility` who may see it; a STOP-level reference names its stop.
 */
export interface OrderReference {
  code: string
  label?: string | null
  value: string
  level: ReferenceLevel
  stopId?: string | null
  visibility: ReferenceVisibility
}

/** Same shape, stored on the stop rather than the order. */
export type StopReference = OrderReference

export interface FreightDimensions {
  l: number
  w: number
  h: number
  unit: 'IN' | 'CM'
}

export interface FreightHazmat {
  un: string
  hazClass: string
  packingGroup?: string | null
  emergencyContact: string
}

/** One line of what is on the truck. */
export interface FreightItem {
  id: string
  handlingUnit: HandlingUnit
  qty: number
  description?: string | null
  dims?: FreightDimensions | null
  weightLbs?: number | null
  freightClass?: string | null
  nmfc?: string | null
  hazmat?: FreightHazmat | null
  stackable?: boolean | null
  highValue?: boolean | null
}

export interface TemperatureRange {
  target: number
  min: number
  max: number
}

export interface SpecialRequirements {
  team?: boolean | null
  tarps?: boolean | null
  straps?: boolean | null
  liftgate?: boolean | null
  hazmat?: boolean | null
  tempF?: TemperatureRange | null
  other?: string[] | null
}

/** Who to hand paperwork to at a stop. */
export interface StopDocumentContact {
  name?: string | null
  phone?: string | null
  email?: string | null
}

export interface ShipmentRecord {
  id: string
  /** `shipmentPrefix` + padded counter; backfilled rows keep `L<aljexId>`. */
  number: string
  status: ShipmentStatus
  /** What ON_HOLD / CANCELED interrupted, so un-hold and un-cancel can put it back. */
  previousStatus?: ShipmentStatus | null
  statusChangedAt?: string | null
  statusChangedBy?: string | null
  holdReason?: string | null
  cancelReason?: string | null
  tenderRejectReason?: string | null
  deletedAt?: string | null
  deletedBy?: string | null
  customerId: string
  customerName?: string | null
  mode: ShipmentMode
  /** Consolidation parent. Always null in step B. */
  parentShipmentId?: string | null
  orderIds?: string[] | null
  loadIds?: string[] | null
  // Mirrors of the first pickup / last delivery, kept so the board sorts and filters
  // without reading every load.
  pickupAppt?: string | null
  deliveryAppt?: string | null
  pickupMonth?: string | null
  originCity?: string | null
  destinationCity?: string | null
  /** Lower-cased number · customer · cities · reference values, for board search. */
  searchKey?: string | null
  source: ShipmentSource
  // Step D — the customer tracking link, one stable token per shipment
  customerLinkId?: string | null
  customerLinkSentAt?: string | null
  // Step E — delivery and the notices it triggered
  /** Stamped when every load of the shipment has delivered. */
  deliveredAt?: string | null
  lastNoticeAt?: string | null
  lastNoticeStatus?: string | null
  // Step R — revenue ownership, Void and the DAT board
  /** Top-level `OwnershipDivision` code this shipment's revenue belongs to. */
  revDivision?: string | null
  /** The matched descendant division, when the rule resolved deeper than the top. */
  revSubdivision?: string | null
  /** `HAND` beats the rules and survives a carrier or driver change. */
  revTagSource?: RevTagSource | null
  /** The `OwnershipRule` that resolved the tag, when `revTagSource` is `RULE`. */
  revRuleId?: string | null
  /** Who set a `HAND` tag; null while the rules decide. */
  revTaggedBy?: string | null
  /** Cognito username of the rep who sold it. */
  salesRepId?: string | null
  /** Void is the only exit: the PRO, the history and the documents all stay. */
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  /** When the load was posted to the DAT board (written in step J). */
  datPostedAt?: string | null
  createdBy: string
  updatedBy: string
  version?: number | null
  createdAt: string
  updatedAt: string
}

export interface OrderRecord {
  id: string
  shipmentId: string
  customerId: string
  customerName?: string | null
  customerContactId?: string | null
  customerRepId?: string | null
  billToId?: string | null
  costCenter?: string | null
  mode: ShipmentMode
  rateType?: RateType | null
  references?: OrderReference[] | null
  equipmentType?: string | null
  equipmentLengthFt?: number | null
  specialRequirements?: SpecialRequirements | null
  freight?: FreightItem[] | null
  customerNotes?: string | null
  internalNotes?: string | null
  /** Cached from the CUSTOMER charge lines: rate = linehaul + FSC, revenue = all lines. */
  customerRateCents?: number | null
  revenueCents?: number | null
  arStatus?: ArStatus | null
  arStatusChangedAt?: string | null
  invoiceId?: string | null
  /** Lets AR move ahead of delivery for customers that bill on pickup. */
  invoiceEarly?: boolean | null
  readyToInvoiceAt?: string | null
  // Step F — cached from the Invoice, so no board cell has to read the invoice row
  invoiceNumber?: string | null
  invoicedAt?: string | null
  paidAt?: string | null
  /** What is still owed on this order. Null before it is invoiced. */
  arBalanceCents?: number | null
  /** The OTR queue row Send to Factor wrote for this order's invoice. */
  factoringItemId?: string | null
  // Step E — what the required-document gate decided last time anything changed
  docsRequired?: string[] | null
  /** `[]` means complete. The board's Docs column reads this. */
  docsMissing?: string[] | null
  docsCheckedAt?: string | null
  docsOverrideAt?: string | null
  docsOverrideBy?: string | null
  docsOverrideNote?: string | null
  pickupAppt?: string | null
  createdBy: string
  updatedBy: string
  version?: number | null
  createdAt: string
  updatedAt: string
}

/**
 * One assignment of a load to somebody who can haul it — our own driver and truck, or
 * an outside carrier. Bounces and TONUs keep their row; only one is ACTIVE at a time.
 */
export interface LoadCarrierRecord {
  id: string
  loadId: string
  shipmentId: string
  kind: LoadCarrierKind
  status: LoadCarrierStatus
  removalReason?: string | null
  removedAt?: string | null
  removedBy?: string | null
  /** 1-based order of assignment attempts on this load. */
  sequence?: number | null
  carrierId?: string | null
  carrierName?: string | null
  carrierMc?: string | null
  carrierRepId?: string | null
  dispatcherName?: string | null
  dispatcherPhone?: string | null
  dispatcherEmail?: string | null
  driverId?: string | null
  driverName?: string | null
  driverPhone?: string | null
  driver2Name?: string | null
  driver2Phone?: string | null
  truckId?: string | null
  truckNumber?: string | null
  trailerId?: string | null
  trailerNumber?: string | null
  plates?: string | null
  vin?: string | null
  sealNumber?: string | null
  tripNumber?: string | null
  pickupEtaAt?: string | null
  deliveryEtaAt?: string | null
  priorDeliveryAt?: string | null
  priorDeliveryNote?: string | null
  rateConSignedAt?: string | null
  rateConKey?: string | null
  chargesFinalizedAt?: string | null
  /** Cached from the CARRIER charge lines for this assignment. */
  carrierRateCents?: number | null
  costCents?: number | null
  apStatus?: ApStatus | null
  invoiceId?: string | null
  // Step G — AP: what the assignment still owes and when its rung last moved
  /** Sparse `'OPEN'` while the leg owes a carrier money; absent once PAID or bounced. */
  apOpen?: string | null
  apStatusChangedAt?: string | null
  apBalanceCents?: number | null
  apPaidAt?: string | null
  // Step C — quick pay, the rate confirmation and the booking trail
  /** Free text behind `removalReason`, which is an enum. */
  removalNote?: string | null
  quickPay?: boolean | null
  quickPayDays?: number | null
  quickPayFeeBps?: number | null
  /** The AP deduction, cached at booking. Never a CARRIER charge line. */
  quickPayFeeCents?: number | null
  paymentTermsDays?: number | null
  rateConStatus?: RateConStatus | null
  /** Opaque token in the signing link; looked up by scan, so it is never a key. */
  rateConToken?: string | null
  rateConSentAt?: string | null
  rateConSentTo?: string | null
  rateConExpiresAt?: string | null
  rateConDocumentId?: string | null
  rateConSignerName?: string | null
  rateConSignerIp?: string | null
  rateConVersion?: number | null
  bookedAt?: string | null
  /** Findings the booker acknowledged, kept as the record of what they were told. */
  bookingWarnings?: string[] | null
  dispatchedAt?: string | null
  dispatchNote?: string | null
  // Step D — the carrier ping link
  /** The ACTIVE CARRIER_PING TrackingLink, while one is out. */
  trackingLinkId?: string | null
  trackingStartedAt?: string | null
  trackingStoppedAt?: string | null
  // Step E — the carrier upload portal and the carrier's paperwork
  uploadLinkId?: string | null
  podRequestedAt?: string | null
  /** Carrier-scope paperwork still outstanding, cached for step G. Blocks nothing in E. */
  docsMissing?: string[] | null
  ratingStars?: number | null
  ratingNote?: string | null
  ratedAt?: string | null
  ratedBy?: string | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

/** Cached money for one load. `id` is the load id, so there is exactly one per load. */
export interface LoadFinancialsRecord {
  id: string
  loadId: string
  shipmentId: string
  orderId?: string | null
  customerRateCents: number
  revenueCents: number
  carrierRateCents: number
  costCents: number
  profitCents: number
  marginBps: number
  /** Most we may pay a carrier before booking warns; null when no floor is configured. */
  topSpendCents?: number | null
  targetBuyCents?: number | null
  /** Set once invoicing freezes the numbers (step F); recalculation is refused after. */
  frozenAt?: string | null
  frozenBy?: string | null
  updatedBy: string
  version: number
  createdAt: string
  updatedAt: string
}

/** MVMNT's FinancialLineItem: one charge on one side of one shipment. */
export interface LoadChargeRecord {
  id: string
  shipmentId: string
  side: ChargeSide
  orderId?: string | null
  loadId?: string | null
  loadCarrierId?: string | null
  code: string
  label?: string | null
  calculatedBy: ChargeCalc
  rateCents: number
  count?: number | null
  amountCents: number
  /** LINEHAUL and FSC only — these sum to the Customer Rate / Carrier Rate. */
  isRate: boolean
  release?: string | null
  sortOrder: number
  note?: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** What RECALC_CHARGES accepts: the stored row minus everything the server derives. */
export interface LoadChargeInput {
  id?: string | null
  side: ChargeSide
  orderId?: string | null
  loadId?: string | null
  loadCarrierId?: string | null
  code: string
  label?: string | null
  calculatedBy: ChargeCalc
  rateCents: number
  count?: number | null
  isRate: boolean
  release?: string | null
  sortOrder: number
  note?: string | null
}

/** Everything one shipment page needs, returned by every shipment mutation. */
export interface ShipmentBundle {
  shipment: ShipmentRecord
  orders: OrderRecord[]
  loads: ShipmentLoad[]
  loadCarriers: LoadCarrierRecord[]
  charges: LoadChargeRecord[]
  financials: LoadFinancialsRecord[]
  /** Step E: the shipment's typed document index, newest last. */
  documents: ShipmentDocumentRecord[]
}

/**
 * The Load fields the shipment layer added. Declared here (not only on `Load`) so the
 * Lambda and the backfill script can talk about a load without importing the whole
 * own-fleet Load type.
 */
export interface ShipmentLoadFields {
  shipmentId?: string | null
  orderId?: string | null
  /** `<shipment number>-<leg>`. */
  loadNumber?: string | null
  leg?: number | null
  /** Absent on legacy rows that predate the shipment layer. */
  status?: LoadWorkflowStatus | null
  statusChangedAt?: string | null
  statusChangedBy?: string | null
  statusSource?: LoadStatusSource | null
  carrierRepId?: string | null
  assignmentType?: AssignmentType | null
  activeLoadCarrierId?: string | null
  carrierName?: string | null
  equipmentType?: string | null
  divisionKey?: string | null
  trackingProvider?: TrackingProvider | null
  nextCheckCallAt?: string | null
  nextCheckCallNote?: string | null
  /** Sparse GSI key: literally `'OPEN'` while a check call is due, otherwise absent. */
  checkCallOpen?: 'OPEN' | null
  /** `YYYY-MM` of the first pickup, for the board's month GSI. */
  pickupMonth?: string | null
  // Step D — tracking and check calls
  lastCheckCallAt?: string | null
  lastCheckCallType?: CheckCallType | null
  lastKnownAt?: string | null
  lastKnownCity?: string | null
  lastKnownState?: string | null
  lastKnownLat?: number | null
  lastKnownLng?: number | null
  lastKnownSource?: LastKnownSource | null
  /** Unresolved INCIDENT check calls on this load. */
  openIncidentCount?: number | null
  deliveredAt?: string | null
  /** When the notice for the CURRENT `nextCheckCallAt` went out; a reschedule re-arms both. */
  checkCallDueNotifiedAt?: string | null
  checkCallOverdueNotifiedAt?: string | null
}

/**
 * The shipment layer's view of a load: identity, schedule mirrors, the shipment
 * fields, and the stops the drawer renders. A `Load` satisfies it, so the bundle
 * can carry whichever subset the query selected.
 */
export interface ShipmentLoad extends ShipmentLoadFields {
  id: string
  aljexId?: string | null
  pickupAppt?: string | null
  deliveryAppt?: string | null
  originCity?: string | null
  destinationCity?: string | null
  customer?: string | null
  rate?: number | null
  miles?: number | null
  /** What is on the truck, as the booking gates read it. */
  commodity?: string | null
  weight?: number | null
  cargoValueCents?: number | null
  freightDescription?: string | null
  stops?: Stop[] | null
  updatedAt?: string | null
}

// ── Step C — carriers ───────────────────────────────────────────────────────

export type CarrierType = 'TL' | 'LTL' | 'CARTAGE' | 'LINEHAUL' | 'AIR' | 'OCEAN' | 'RAIL' | 'AGENT'
export type CarrierStatus = 'PENDING' | 'REVIEW' | 'ACTIVE' | 'INACTIVE' | 'DO_NOT_USE'
export type CarrierInactiveReason =
  | 'EXPIRED_INSURANCE'
  | 'INACTIVE_AUTHORITY'
  | 'INACTIVE_AGREEMENT'
  | 'SAFETY_ISSUES'
  | 'OTHER'
export type CarrierDoNotUseReason =
  | 'DOUBLE_BROKERING'
  | 'CARGO_CLAIM'
  | 'THEFT'
  | 'FRAUD'
  | 'SUSPICIOUS_ACTIVITY'
export type CarrierStatusReason = CarrierInactiveReason | CarrierDoNotUseReason
export type AuthorityStatus = 'ACTIVE' | 'INACTIVE' | 'NONE' | 'UNKNOWN'
export type SafetyRating = 'SATISFACTORY' | 'CONDITIONAL' | 'UNSATISFACTORY' | 'NONE' | 'UNKNOWN'
export type ComplianceCheckStatus = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'PARTIAL' | 'NONE'
export type CarrierEquipment =
  | 'CONTAINER'
  | 'FLATBED'
  | 'POWER_ONLY'
  | 'REEFER'
  | 'SPECIALIZED'
  | 'TANKER'
  | 'VAN'
export type InsurancePolicyType =
  | 'AUTO_LIABILITY'
  | 'CARGO'
  | 'GENERAL_LIABILITY'
  | 'WORKERS_COMP'
  | 'OTHER'
export type CarrierContactType =
  | 'ACCOUNTING'
  | 'AFTER_HOURS'
  | 'CLAIMS'
  | 'DISPATCH'
  | 'DRIVER'
  | 'EMERGENCY'
  | 'MANAGER'
  | 'OWNER'
export type CarrierPaymentMethodKind = 'ACH' | 'WIRE' | 'CHECK' | 'ZELLE' | 'VENMO' | 'EFT'
export type CarrierPayeeType = 'CARRIER' | 'FACTOR'
export type CarrierDocumentType =
  | 'AUTHORITY'
  | 'COI_AUTO'
  | 'COI_CARGO'
  | 'COI_GENERAL'
  | 'W9'
  | 'CARRIER_AGREEMENT'
  | 'FACTOR_NOA'
  | 'CDL'
  | 'RATE_CON'
  | 'OTHER'
export type CarrierDocumentSource = 'UPLOAD' | 'GENERATED' | 'SIGNED'
export type RateConStatus =
  | 'NOT_SENT'
  | 'SENT'
  | 'OPENED'
  | 'SIGNED'
  | 'DECLINED'
  | 'VOIDED'
  | 'EXPIRED'
export type RateConRequiredField =
  | 'DRIVER_NAME'
  | 'DRIVER_PHONE'
  | 'TRUCK_NUMBER'
  | 'TRAILER_NUMBER'
  | 'PICKUP_ETA'
  | 'PLATES'
  | 'VIN'
export type BookingRequiredField = 'COMMODITY' | 'DESCRIPTION' | 'VALUE' | 'WEIGHT'

/** One certificate of insurance, as the carrier record stores it. */
export interface InsurancePolicy {
  id: string
  type: InsurancePolicyType
  company?: string | null
  policyNumber?: string | null
  agentName?: string | null
  agentPhone?: string | null
  limitCents?: number | null
  deductibleCents?: number | null
  effectiveAt?: string | null
  expiresAt?: string | null
  exclusions?: string | null
}

/** One rung of the quick-pay ladder: pay in `days`, keep `feeBps` of the rate. */
export interface QuickPayTier {
  days: number
  feeBps: number
}

/**
 * An outside carrier. `status` is what somebody set; what booking actually reads is
 * `effectiveCarrierStatus`, which can demote an ACTIVE carrier whose cargo insurance
 * has run out. Compliance portals (Highway, RMIS, MCP) are typed in by hand for now.
 */
export interface CarrierRecord {
  id: string
  name: string
  dbaName?: string | null
  normalizedName?: string | null
  type: CarrierType
  status: CarrierStatus
  statusReason?: CarrierStatusReason | null
  statusNote?: string | null
  statusChangedAt?: string | null
  statusChangedBy?: string | null
  mcNumber?: string | null
  dotNumber?: string | null
  scac?: string | null
  einNumber?: string | null
  inFmcsa?: boolean | null
  authorityStatus?: AuthorityStatus | null
  authorityGrantedAt?: string | null
  authorityExpiresAt?: string | null
  safetyRating?: SafetyRating | null
  safetyRatingAt?: string | null
  reviewType?: string | null
  reviewedAt?: string | null
  driverInspections?: number | null
  driverOos?: number | null
  vehicleInspections?: number | null
  vehicleOos?: number | null
  insurancePolicies?: InsurancePolicy[] | null
  equipment?: string[] | null
  cargoTypes?: string[] | null
  powerUnits?: number | null
  trailerCount?: number | null
  driverCount?: number | null
  address?: Record<string, unknown> | null
  phone?: string | null
  email?: string | null
  website?: string | null
  dispatcherName?: string | null
  dispatcherPhone?: string | null
  dispatcherEmail?: string | null
  paymentTermsDays?: number | null
  quickPayEligible?: boolean | null
  defaultQuickPayDays?: number | null
  factorPaymentMethodId?: string | null
  highwayStatus?: ComplianceCheckStatus | null
  rmisStatus?: ComplianceCheckStatus | null
  mcpStatus?: string | null
  accountOwnerIds?: string[] | null
  teamKey?: string | null
  internalNotes?: string | null
  loadCount?: number | null
  lastLoadAt?: string | null
  createdBy: string
  updatedBy: string
  version?: number | null
  createdAt: string
  updatedAt: string
}

/** A person at the carrier. At most one is `isPrimary`. */
export interface CarrierContactRecord {
  id: string
  carrierId: string
  name: string
  types?: CarrierContactType[] | null
  email?: string | null
  phone?: string | null
  isPrimary?: boolean | null
  rateConRecipient?: boolean | null
  active?: boolean | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

/** Where the carrier's money goes. Only the last four digits are ever stored here. */
export interface CarrierPaymentMethodRecord {
  id: string
  carrierId: string
  method: CarrierPaymentMethodKind
  recipientType: CarrierPayeeType
  factorName?: string | null
  factorAddress?: Record<string, unknown> | null
  bankName?: string | null
  accountName?: string | null
  accountLast4?: string | null
  routingLast4?: string | null
  bankDetailsKey?: string | null
  payeeEmail?: string | null
  remitToAddress?: Record<string, unknown> | null
  isPreferred?: boolean | null
  status?: 'ACTIVE' | 'INACTIVE' | null
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

/** A file on the carrier — uploaded by us, or generated and signed by them. */
export interface CarrierDocumentRecord {
  id: string
  carrierId: string
  type: CarrierDocumentType
  name: string
  s3Key: string
  contentType: string
  sizeBytes: number
  expiresAt?: string | null
  loadCarrierId?: string | null
  source: CarrierDocumentSource
  uploadedBy: string
  createdAt: string
  updatedAt: string
}

/** Everything one carrier page needs, returned by every carrier mutation. */
export interface CarrierBundle {
  carrier: CarrierRecord
  contacts: CarrierContactRecord[]
  paymentMethods: CarrierPaymentMethodRecord[]
  documents: CarrierDocumentRecord[]
  loadCarriers: LoadCarrierRecord[]
}

// ── Step D — tracking and check calls ───────────────────────────────────────
//
// One event log (LoadCheckCall) and one token table (TrackingLink) carry every
// tracking fact: what somebody was told on the phone, what the driver app stamped,
// what a tapped link pinged. The rules that read them are pure and live in
// src/lib/checkCalls.ts, src/lib/trackingTimeline.ts and src/lib/trackingLink.ts.

export type CheckCallType =
  | 'DISPATCH'
  | 'LOCATION_UPDATE'
  | 'ARRIVED'
  | 'DEPARTED'
  | 'ETA_UPDATE'
  | 'INCIDENT'
  | 'NOTE'
  | 'TRACKING_LINK_SENT'
  | 'TRACKING_PING'

/** The two events that stamp a stop clock, and so can move a load's status. */
export type StopEventType = 'ARRIVED' | 'DEPARTED'

export type CheckCallSource = 'MANUAL' | 'DRIVER_APP' | 'LINK' | 'SYSTEM'

/** Where `Load.lastKnown*` came from. Motive fixes never become check calls. */
export type LastKnownSource = 'MANUAL' | 'DRIVER_APP' | 'LINK' | 'MOTIVE' | 'SYSTEM'

/** MVMNT's `LoadCheckCallIncidentType`, verbatim (spec §6.1). */
export type IncidentType =
  | 'ACCIDENT'
  | 'ACTUAL_CLAIM'
  | 'ATTEMPTED_DELIVERY'
  | 'BREAKDOWN'
  | 'DELAY'
  | 'DELIVERY_NOT_COMPLETED'
  | 'DETENTION'
  | 'FRAUD'
  | 'GENERAL_EXCEPTION'
  | 'LAYOVER'
  | 'LOAD_LOCK_ALERT'
  | 'OVERAGE_SHORTAGE'
  | 'PICKUP_EXCEPTION'
  | 'POTENTIAL_CLAIM'
  | 'REFUSED_BY_CONSIGNEE'
  | 'REJECTION'
  | 'SHIPMENT_CANCELLED'
  | 'SHIPMENT_DAMAGED'
  | 'SHIPMENT_DELAYED'
  | 'SHIPMENT_RECONSIGNED'
  | 'SHIPMENT_RETURNED_TO_SHIPPER'
  | 'STORAGE_IN_TRANSIT'
  | 'TONU'

export type CheckCallNotifyChannel = 'IN_APP' | 'SLACK' | 'BOTH'

/** Who the customer tracking page says to call: the order's rep, or a fixed desk. */
export interface TrackingContact {
  mode: 'CUSTOMER_REP' | 'FIXED'
  name?: string | null
  email?: string | null
  phone?: string | null
}

/** What an incident charged, snapshotted on the check call that raised it. */
export interface CheckCallChargeSnapshot {
  side: ChargeSide
  code: string
  amountCents: number
  chargeId?: string | null
}

/**
 * One row of a load's tracking log. Stop events use the deterministic id
 * `evt:<loadId>:<stopId>:<ARRIVED|DEPARTED>` so the staff action and the driver-app
 * projector can never count the same stamp twice; everything else is a UUID.
 */
export interface LoadCheckCallRecord {
  id: string
  loadId: string
  shipmentId: string
  loadCarrierId?: string | null
  stopId?: string | null
  /** When it happened. `createdAt` is when it was logged. */
  at: string
  type: CheckCallType
  source: CheckCallSource
  incidentType?: IncidentType | null
  /** Sparse GSI key: literally `'OPEN'` while the incident is unresolved. */
  incidentOpen?: 'OPEN' | null
  resolvedAt?: string | null
  resolvedBy?: string | null
  resolutionNote?: string | null
  statusBefore?: LoadWorkflowStatus | null
  /** Null when the call moved nothing. */
  statusAfter?: LoadWorkflowStatus | null
  city?: string | null
  state?: string | null
  lat?: number | null
  lng?: number | null
  accuracyM?: number | null
  personName?: string | null
  note?: string | null
  /** DispatchMessage id, when the note was also texted to the driver. */
  driverMessageId?: string | null
  charges?: CheckCallChargeSnapshot[] | null
  /** What this call scheduled. */
  nextCheckCallAt?: string | null
  nextCheckCallNote?: string | null
  pickupEtaAt?: string | null
  deliveryEtaAt?: string | null
  /** Staff e-mail · `driver:<id>` · `link:<token8>` · `system`. */
  createdBy: string
  createdAt?: string
  updatedAt?: string
}

export type TrackingLinkKind = 'CARRIER_PING' | 'CUSTOMER_VIEW' | 'CARRIER_UPLOAD'
export type TrackingLinkStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED'
export type TrackingLinkChannel = 'SMS' | 'EMAIL' | 'COPY'

/**
 * A tokenised public link. The `id` **is** the token (24 random bytes base64url), so
 * the public Lambda reads it by primary key and no token index exists anywhere.
 */
export interface TrackingLinkRecord {
  id: string
  kind: TrackingLinkKind
  shipmentId: string
  loadId?: string | null
  loadCarrierId?: string | null
  status: TrackingLinkStatus
  expiresAt: string
  /** E.164 phone, or comma-joined e-mails. */
  sentTo?: string | null
  sentVia?: TrackingLinkChannel | null
  sentAt?: string | null
  smsMessageId?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  /** Settings snapshot, so later setting changes never widen a link already sent. */
  showCarrier?: boolean | null
  showPosition?: boolean | null
  openCount?: number | null
  lastOpenedAt?: string | null
  /** Request budget, so a leaked link cannot be scraped forever. */
  requestCount?: number | null
  pingCount?: number | null
  lastPingAt?: string | null
  lastPingLat?: number | null
  lastPingLng?: number | null
  lastPingAccuracyM?: number | null
  revokedAt?: string | null
  revokedBy?: string | null
  /** CARRIER_UPLOAD only: the link's file budget and what it was minted asking for. */
  uploadCount?: number | null
  lastUploadAt?: string | null
  neededTypes?: string[] | null
  createdBy: string
  createdAt?: string
  updatedAt?: string
}

/** A reference number a tracking page is allowed to print. */
export interface TrackingViewReference {
  code: string
  label: string | null
  value: string
}

/** One stop as a tracking page renders it: the appointment and the clock, nothing else. */
export interface TrackingViewStop {
  id: string
  type: StopType
  sequence: number
  name: string | null
  city: string | null
  state: string | null
  appt: string | null
  apptEnd: string | null
  arrivedAt: string | null
  departedAt: string | null
  references: TrackingViewReference[]
}

export interface TrackingViewPosition {
  lat: number
  lng: number
  at: string
  description: string | null
}

export interface TrackingViewContact {
  name: string | null
  email: string | null
  phone: string | null
}

/**
 * What the Customer Link shows. Everything a customer must not see — rates, margin,
 * the carrier, driver and dispatcher phones, internal references — is absent from the
 * shape itself, so there is nothing to forget to strip.
 */
export interface CustomerTrackingView {
  broker: { name: string }
  number: string
  status: ShipmentStatus
  statusLabel: string
  stops: TrackingViewStop[]
  references: TrackingViewReference[]
  eta: string | null
  /** Rounded to three decimals (~100 m). Absent when the link hides position. */
  position?: TrackingViewPosition
  lastUpdate: { at: string; type: CheckCallType } | null
  /** Name only, and only when the link was minted with `showCarrier`. */
  carrier?: { name: string }
  contact: TrackingViewContact | null
  generatedAt: string
}

export interface TrackingViewPing {
  at: string
  lat: number | null
  lng: number | null
  accuracyM: number | null
}

/** What the driver's ping link shows. No customer, no money. */
export interface CarrierTrackingView {
  loadNumber: string
  status: LoadWorkflowStatus
  statusLabel: string
  stops: TrackingViewStop[]
  nextStop: TrackingViewStop | null
  /** The pings this link itself sent, so the driver sees the tap landed. */
  pings: TrackingViewPing[]
  contactPhone: string | null
  generatedAt: string
}

// ── Step E — documents and delivery ─────────────────────────────────────────
//
// One index table (ShipmentDocument) carries every file a shipment has, wherever
// the bytes live: uploads and generated PDFs under `shipment-docs/{shipmentId}/`,
// driver-app PODs and legacy rate cons as pointer rows into the stores that
// already hold them. One notice table (ShipmentNotice) records every e-mail the
// system tried to send with the text it rendered, so a send that SES refuses is
// still a readable, copyable artifact. The rules that read them are pure and live
// in src/lib/shipmentDocuments.ts, src/lib/shipmentNotices.ts and
// src/lib/uploadPortal.ts.

export type ShipmentDocumentType =
  | 'BOL'
  | 'POD'
  | 'RATE_CON'
  | 'CUSTOMER_RATE_CON'
  | 'LOAD_SUMMARY'
  | 'LUMPER_RECEIPT'
  | 'WEIGHT_TICKET'
  | 'TEMP_LOG'
  | 'INSPECTION_REPORT'
  | 'CUSTOMS'
  | 'PACKING_LIST'
  | 'CARRIER_INVOICE'
  | 'INVOICE'
  | 'PHOTO'
  | 'OTHER'

/** Where the bytes came from. DRIVER_APP and LEGACY rows point at another store. */
export type ShipmentDocumentSource =
  | 'UPLOAD'
  | 'CARRIER_PORTAL'
  | 'GENERATED'
  | 'DRIVER_APP'
  | 'LEGACY'

/** Who may receive the file outside the company. INTERNAL never leaves. */
export type ShipmentDocumentAudience = 'CUSTOMER' | 'CARRIER' | 'ALL' | 'INTERNAL'

export type ShipmentDocumentStatus = 'ACTIVE' | 'SUPERSEDED' | 'VOID'

/** Sparse: only CARRIER_PORTAL rows ever carry PENDING, which is the review queue. */
export type ShipmentDocumentReviewStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED'

/** Which block of the Documents tab a row belongs to. */
export type ShipmentDocumentSection = 'CUSTOMER' | 'CARRIER' | 'SHIPMENT'

/**
 * One file attached to one shipment. `id` is `sdoc-<uuid>` for anything this system
 * writes, and deterministic (`drv:<submissionDocId>`, `rck:<loadId>`) for pointer
 * rows, so a backfill re-run or a stream retry can never list the same file twice.
 */
export interface ShipmentDocumentRecord {
  id: string
  shipmentId: string
  /** Set → the Customer section. */
  orderId?: string | null
  loadId?: string | null
  /** Set → the Carrier section, under that assignment. */
  loadCarrierId?: string | null
  stopId?: string | null
  type: ShipmentDocumentType
  name: string
  s3Key: string
  contentType: string
  sizeBytes: number
  pages?: number | null
  source: ShipmentDocumentSource
  /** The DriverSubmissionDoc / Load id a pointer row points at. */
  sourceRef?: string | null
  audience: ShipmentDocumentAudience
  status: ShipmentDocumentStatus
  /** Per shipment + type + loadId. A regenerated BOL is v2, not a rewrite of v1. */
  version: number
  supersedesId?: string | null
  reviewStatus?: ShipmentDocumentReviewStatus | null
  reviewedAt?: string | null
  reviewedBy?: string | null
  reviewNote?: string | null
  uploadLinkId?: string | null
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  /** Staff e-mail · `link:<token8>` · `driver:<id>` · `migration:<script>`. */
  uploadedBy: string
  /** When the file was attached; the sort key of both indexes. */
  uploadedAt: string
  createdBy: string
  createdAt?: string
  updatedAt?: string
}

export type ShipmentNoticeKind =
  | 'MILESTONE'
  | 'POD_REQUEST'
  | 'DOCUMENTS'
  | 'INVOICE'
  | 'REMITTANCE'
  /** Step H: an offer request sent to a carrier on this load. */
  | 'CARRIER_OFFER'

export type ShipmentNoticeChannel = 'EMAIL' | 'COPY'

/** NOT_SENT is an honest dev outcome: the row and its body exist, SES refused. */
export type ShipmentNoticeStatus = 'SENT' | 'NOT_SENT' | 'FAILED' | 'COPY'

export interface ShipmentNoticeAttachment {
  documentId: string
  name: string
  sizeBytes: number
}

/**
 * Every e-mail step E tries to send, with the text it rendered. Milestone rows use
 * the deterministic id `ms:<shipmentId>:<milestone>` and the first POD request
 * `pod:<loadCarrierId>`, so a second leg or a stream retry never sends twice.
 */
export interface ShipmentNoticeRecord {
  id: string
  shipmentId: string
  loadId?: string | null
  loadCarrierId?: string | null
  kind: ShipmentNoticeKind
  milestone?: CustomerNotification | null
  channel: ShipmentNoticeChannel
  /** Comma-joined. */
  to: string
  cc?: string | null
  subject: string
  body: string
  attachments?: ShipmentNoticeAttachment[] | null
  status: ShipmentNoticeStatus
  error?: string | null
  messageId?: string | null
  sentAt?: string | null
  trackingLinkId?: string | null
  /** When the send was attempted; the sort key of the shipment index. */
  at: string
  createdBy: string
  createdAt?: string
  updatedAt?: string
}

/** What the required-document gate decided for one scope. */
export interface DocGateResult {
  required: ShipmentDocumentType[]
  present: ShipmentDocumentType[]
  missing: ShipmentDocumentType[]
  ready: boolean
  /** Free-text entries nobody could map to a type; they never block. */
  unrecognised: string[]
}

/** One line of the carrier portal's "we still need" checklist. */
export interface UploadNeededType {
  type: ShipmentDocumentType
  label: string
  satisfied: boolean
}

export interface UploadPortalStop {
  type: StopType
  name: string | null
  city: string | null
  state: string | null
  appt: string | null
}

export interface UploadPortalUpload {
  id: string
  type: ShipmentDocumentType
  name: string
  sizeBytes: number
  uploadedAt: string
  reviewStatus: ShipmentDocumentReviewStatus
}

/**
 * What the carrier upload portal shows. The customer, the money and every reference
 * are absent from the shape itself, so there is nothing to forget to strip.
 */
export interface CarrierUploadView {
  broker: { name: string }
  loadNumber: string
  carrierName: string | null
  stops: UploadPortalStop[]
  needed: UploadNeededType[]
  /** Only the rows this link itself uploaded. */
  uploads: UploadPortalUpload[]
  expiresAt: string
  acceptedTypes: string[]
  maxBytes: number
  contactPhone: string | null
  generatedAt: string
}

// ── AR: invoicing & payments (Step F) ────────────────────────────────────────

export type InvoiceStatus = 'ISSUED' | 'PARTIAL' | 'PAID' | 'VOID'

export type InvoiceBatchEmailMode = 'PER_INVOICE' | 'PER_BILL_TO'

/** Where the money is sent. The division's own, or the factor's for a factored customer. */
export interface RemitTo {
  name: string
  address?: Address | null
  email?: string | null
  /** The assignment notice a factor requires on the face of the invoice. */
  noticeText?: string | null
}

/** Who is billed, frozen at issue. A later edit to the bill-to does not move it. */
export interface InvoiceBillTo {
  name: string
  address?: Address | null
  email?: string | null
}

/** One charge line, copied off the order's CUSTOMER LoadCharge rows at issue. */
export interface InvoiceLine {
  chargeId: string
  loadId?: string | null
  code: string
  label?: string | null
  calculatedBy?: ChargeCalc | null
  rateCents: number
  count: number
  amountCents: number
}

/**
 * One issued bill for one order. `id` is the invoice number.
 *
 * Everything printed on it is a snapshot: lines, references, bill-to, remit-to, terms
 * and due date are taken once and never re-read from the order. A mistake is voided
 * and re-issued, never edited.
 */
export interface InvoiceRecord {
  id: string
  number: string
  orderId: string
  shipmentId: string
  shipmentNumber?: string | null
  customerId: string
  customerName?: string | null
  billToId?: string | null
  billTo?: InvoiceBillTo | null
  divisionKey?: string | null
  status: InvoiceStatus
  /** YYYY-MM-DD. */
  invoiceDate: string
  issuedAt: string
  issuedBy: string
  /** YYYY-MM-DD. */
  dueAt: string
  termsDays: number
  /** The terms text as printed. Snapshotted so a re-render reproduces the sent bill. */
  termsText?: string | null
  /** 'YYYY-MM' of invoiceDate. */
  invoiceMonth: string
  lines?: InvoiceLine[] | null
  references?: OrderReference[] | null
  subtotalCents: number
  totalCents: number
  paidCents: number
  writtenOffCents: number
  balanceCents: number
  /** Sparse `'OPEN'` while ISSUED or PARTIAL; absent once PAID or VOID. */
  arOpen?: string | null
  paidAt?: string | null
  remitTo?: RemitTo | null
  factored?: boolean | null
  factoringItemId?: string | null
  pdfKey?: string | null
  pdfSizeBytes?: number | null
  pdfVersion?: number | null
  attachDocumentIds?: string[] | null
  sentAt?: string | null
  /** Comma-joined, like `ShipmentNotice.to`. */
  sentTo?: string | null
  sentCount?: number | null
  markedSentAt?: string | null
  markedSentBy?: string | null
  markedSentNote?: string | null
  lastNoticeId?: string | null
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  note?: string | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt?: string
  updatedAt?: string
}

export type ArPaymentKind = 'PAYMENT' | 'CREDIT_MEMO' | 'WRITE_OFF' | 'REVERSAL'

export type ArPaymentMethod = 'CHECK' | 'ACH' | 'WIRE' | 'CARD' | 'FACTOR' | 'OTHER'

/** Money from this row put against one invoice. */
export interface PaymentApplication {
  invoiceId: string
  amountCents: number
}

/** Unapplied money on an earlier row spent by this one. */
export interface CreditApplication {
  paymentId: string
  amountCents: number
}

/**
 * One posted cash row: a receipt, a credit memo, a write-off or a reversal.
 *
 * Immutable once written, except `unappliedCents` — spent down by a later payment with
 * a conditional ADD — and `reversedByPaymentId`. Nothing deletes one; a mistake gets a
 * REVERSAL row that restores the balances it took.
 */
export interface ArPaymentRecord {
  id: string
  customerId: string
  kind: ArPaymentKind
  /** The typed date at noon UTC, so a timezone cannot slide a receipt into last month. */
  receivedAt: string
  method?: ArPaymentMethod | null
  reference?: string | null
  amountCents: number
  appliedCents: number
  unappliedCents: number
  applications?: PaymentApplication[] | null
  creditApplications?: CreditApplication[] | null
  /** WRITE_OFF names the invoice it clears. */
  invoiceId?: string | null
  reversesPaymentId?: string | null
  reversedByPaymentId?: string | null
  note?: string | null
  createdBy: string
  createdAt?: string
  updatedAt?: string
}

/** The AR half of `TmsSettings`, as the settings card edits it. */
export interface ArSettings {
  invoiceNumberFormat?: string | null
  nextInvoiceNumber?: number | null
  invoiceTerms?: string | null
  invoiceEmailTemplate?: string | null
  invoiceAttachTypes?: string[] | null
  factorRemitTo?: RemitTo | null
  arPostingAdminOnly?: boolean | null
  invoiceBatchEmail?: InvoiceBatchEmailMode | null
  defaultPaymentTermsDays?: number | null
}

// ── AP: carrier bills & payments (Step G) ────────────────────────────────────

export type CarrierBillStatus = 'IN_REVIEW' | 'TO_BE_PAID' | 'PARTIAL' | 'PAID' | 'VOID'

/** Who is owed is always the carrier; this says where the money is sent. */
export type ApPayeeKind = 'CARRIER' | 'FACTOR'

export type ApPaymentKind = 'PAYMENT' | 'CREDIT_MEMO' | 'REVERSAL'

export type ApPaymentMethod = 'ACH' | 'WIRE' | 'CHECK' | 'ZELLE' | 'VENMO' | 'EFT' | 'OTHER'

/**
 * Where a carrier's money goes, snapshotted onto the bill at Record.
 *
 * Never carries `bankDetailsKey`: the account itself stays in S3 behind the carrier
 * directory, and a bill is read by anyone who can read the AP board.
 */
export interface ApRemitTo {
  name: string
  factorName?: string | null
  method?: ApPaymentMethod | null
  accountLast4?: string | null
  payeeEmail?: string | null
  address?: Address | null
}

/** One charge line, copied off the assignment's CARRIER LoadCharge rows at Record. */
export interface CarrierBillLine {
  chargeId: string
  code: string
  label?: string | null
  calculatedBy?: ChargeCalc | null
  rateCents: number
  count: number
  amountCents: number
}

/**
 * One recorded bill for one carrier assignment.
 *
 * Lines, fee, terms and remit-to are a snapshot taken at RECORD_BILL in the same
 * transaction that finalizes the assignment's charges. A mistake is voided and
 * re-recorded, never edited.
 */
export interface CarrierBillRecord {
  id: string
  loadCarrierId: string
  loadId: string
  shipmentId: string
  shipmentNumber?: string | null
  loadNumber?: string | null
  carrierId: string
  carrierName?: string | null
  carrierMc?: string | null
  payeeKind: ApPayeeKind
  paymentMethodId?: string | null
  remitTo?: ApRemitTo | null
  divisionKey?: string | null
  status: CarrierBillStatus
  /** The carrier's own invoice number. */
  billNumber?: string | null
  /** YYYY-MM-DD. */
  billDate: string
  /** 'YYYY-MM' of billDate. */
  billMonth: string
  recordedAt: string
  recordedBy: string
  /** Recorded before the load delivered — approval says so out loud. */
  recordedEarly?: boolean | null
  /** YYYY-MM-DD. */
  dueAt: string
  termsDays: number
  quickPay?: boolean | null
  quickPayDays?: number | null
  quickPayFeeBps?: number | null
  lines?: CarrierBillLine[] | null
  grossCents: number
  quickPayFeeCents: number
  /** gross − fee. What we actually pay. */
  netCents: number
  /** What the carrier's invoice says. */
  billedCents: number
  /** billed − gross. Must be zero before the bill can be approved. */
  varianceCents: number
  paidCents: number
  creditedCents: number
  /** net − paid − credited. */
  balanceCents: number
  /** Sparse `'OPEN'` while IN_REVIEW, TO_BE_PAID or PARTIAL; absent once PAID or VOID. */
  apOpen?: string | null
  documentId?: string | null
  approvedAt?: string | null
  approvedBy?: string | null
  approvalWarnings?: string[] | null
  docsOverrideAt?: string | null
  docsOverrideBy?: string | null
  docsOverrideNote?: string | null
  paidAt?: string | null
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  note?: string | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt?: string
  updatedAt?: string
}

/**
 * Money from one AP payment put against one bill.
 *
 * `creditCents` is the slice of it that came out of an AP credit rather than out of
 * the bank, recorded at post so a reversal restores exactly what it took.
 */
export interface ApPaymentApplication {
  billId: string
  amountCents: number
  creditCents?: number
}

/**
 * One posted AP row: a payment we sent, a credit we hold against a carrier, or a
 * reversal. Immutable once written, except `unappliedCents` — spent down by a later
 * payment with a conditional ADD — and `reversedByPaymentId`.
 */
export interface ApPaymentRecord {
  id: string
  carrierId: string
  payeeKind?: ApPayeeKind | null
  kind: ApPaymentKind
  /** The typed date at noon UTC, so a timezone cannot slide a payment into last month. */
  paidAt: string
  method?: ApPaymentMethod | null
  reference?: string | null
  amountCents: number
  appliedCents: number
  unappliedCents: number
  applications?: ApPaymentApplication[] | null
  creditApplications?: CreditApplication[] | null
  remitTo?: ApRemitTo | null
  /** A credit raised against one assignment (a TONU adjustment, a claim). */
  loadCarrierId?: string | null
  reversesPaymentId?: string | null
  reversedByPaymentId?: string | null
  pdfKey?: string | null
  pdfVersion?: number | null
  remittanceSentAt?: string | null
  remittanceSentTo?: string | null
  remittanceCount?: number | null
  markedSentAt?: string | null
  markedSentBy?: string | null
  markedSentNote?: string | null
  lastNoticeId?: string | null
  note?: string | null
  createdBy: string
  createdAt?: string
  updatedAt?: string
}

/** The AP half of `TmsSettings`, as the settings card edits it. */
export interface ApSettings {
  apApprovalAdminOnly?: boolean | null
  apPostingAdminOnly?: boolean | null
  apRequireSignedRateCon?: boolean | null
  remittanceEmailTemplate?: string | null
  apBillDocsRequired?: string[] | null
  defaultCarrierTermsDays?: number | null
}

// ── Step H — quotes, carrier offers and lane history ─────────────────────────

/** A customer quote (SELL) or a carrier offer (BUY). One model, two sides. */
export type QuoteSide = 'SELL' | 'BUY'

/**
 * The rungs. `REQUESTED` is "somebody asked and we have not priced it" (a sell-side
 * intake, or an offer request sitting with a carrier); `QUOTED` is "our number is
 * with them"; the two RECEIVED_* rungs are "their move landed, it is ours now".
 * WON is written only at conversion (SELL) or booking (BUY).
 */
export type QuoteStatus =
  | 'DRAFT'
  | 'REQUESTED'
  | 'QUOTED'
  | 'SENT_COUNTER'
  | 'RECEIVED_REPLY'
  | 'RECEIVED_COUNTER'
  | 'WON'
  | 'LOST'
  | 'PASS'
  | 'CANCELED'

export type QuoteResponseKind = 'ACCEPTED' | 'COUNTERED' | 'DECLINED' | 'PASSED'

export type QuoteLostReason =
  | 'EXPIRED'
  | 'NO_RESPONSE'
  | 'TOO_HIGH'
  | 'TOO_SLOW'
  | 'TRUCK_NOT_AVAILABLE'
  | 'WITHDRAWN'
  | 'OTHER'
  | 'NO_REASON'

export type QuoteAcceptedVia = 'LINK' | 'PHONE' | 'EMAIL'

export type QuoteCounterBy = 'US' | 'THEM'

export type QuoteSendStatus = 'SENT' | 'NOT_SENT'

/** One line of the quote's thread: what happened, when, and at what number. */
export interface QuoteEvent {
  at: string
  by: string
  kind: string
  amountCents?: number | null
  note?: string | null
}

/**
 * One priced thing. `id` is the quote number (`Q000012`), minted from a settings
 * counter, so a staff URL carries no secret and a lookup by number is a GetItem.
 * `linkToken` is the public secret; it is rotated every round and REMOVEd the
 * moment the other side answers.
 */
export interface QuoteRecord {
  id: string
  side: QuoteSide
  status: QuoteStatus
  /** A sell quote and its duplicates, or one request round across carriers. */
  groupId?: string | null
  quoteDate: string
  quoteMonth: string
  customerId?: string | null
  customerName?: string | null
  contactName?: string | null
  contactEmail?: string | null
  customerRepId?: string | null
  carrierId?: string | null
  carrierName?: string | null
  carrierMc?: string | null
  carrierEmail?: string | null
  shipmentId?: string | null
  shipmentNumber?: string | null
  orderId?: string | null
  loadId?: string | null
  loadNumber?: string | null
  divisionKey?: string | null
  mode?: ShipmentMode | null
  rateType?: RateType | null
  equipmentType?: string | null
  equipmentLengthFt?: number | null
  stops?: Stop[] | null
  laneKey?: string | null
  laneKey3?: string | null
  pickupAppt?: string | null
  deliveryAppt?: string | null
  commodity?: string | null
  weightLbs?: number | null
  miles?: number | null
  references?: OrderReference[] | null
  /** SELL: the CUSTOMER lines. BUY: one CARRIER rate line. */
  lines?: LoadChargeInput[] | null
  /** SELL: Σ lines = revenue. BUY: the carrier's number. */
  amountCents: number
  customerRateCents?: number | null
  targetBuyCents?: number | null
  topSpendCents?: number | null
  marginBps?: number | null
  /** BUY only: the number a carrier may accept outright on the link. */
  bookNowRateCents?: number | null
  counterCents?: number | null
  counterBy?: QuoteCounterBy | null
  rounds: number
  expiresAt?: string | null
  /** Sparse and indexed; present only while the current round's link is live. */
  linkToken?: string | null
  linkVersion?: number | null
  requestCount?: number | null
  sentAt?: string | null
  sentTo?: string | null
  sendCount?: number | null
  lastSendStatus?: QuoteSendStatus | null
  respondedAt?: string | null
  response?: QuoteResponseKind | null
  responderName?: string | null
  responderEmail?: string | null
  responderIp?: string | null
  acceptedVia?: QuoteAcceptedVia | null
  lostReason?: QuoteLostReason | null
  lostNote?: string | null
  wonAt?: string | null
  closedAt?: string | null
  duplicatedFromId?: string | null
  pricingWarnings?: string[] | null
  /** Sparse `'OPEN'` from DRAFT through RECEIVED_COUNTER; REMOVEd when it closes. */
  quoteOpen?: string | null
  customerMessage?: string | null
  internalNotes?: string | null
  events?: QuoteEvent[] | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt?: string
  updatedAt?: string
}

export type LaneAssignmentKind = 'OWN_ASSET' | 'CARRIER'

export type LaneSampleSource = 'LOAD' | 'BACKFILL' | 'LEGACY_LOAD'

/**
 * One delivered load, priced, keyed by lane. The only thing the Historical Rates
 * panel reads. `id` is `lrs:<loadId>`, so a re-price overwrites rather than doubles.
 */
export interface LaneRateSampleRecord {
  id: string
  /** `'CHICAGO|IL>DANVILLE|IL'`. */
  laneKey: string
  /** `'606>618'`. */
  laneKey3?: string | null
  date: string
  loadId: string
  shipmentId: string
  shipmentNumber?: string | null
  orderId?: string | null
  customerId?: string | null
  customerName?: string | null
  carrierId?: string | null
  carrierName?: string | null
  assignmentKind?: LaneAssignmentKind | null
  divisionKey?: string | null
  mode?: ShipmentMode | null
  rateType?: RateType | null
  equipmentType?: string | null
  miles?: number | null
  customerRateCents?: number | null
  revenueCents?: number | null
  carrierRateCents?: number | null
  costCents?: number | null
  profitCents?: number | null
  marginBps?: number | null
  loadStatus?: string | null
  /** Canceled or TONU'd after the sample was taken: kept, never counted. */
  excluded?: boolean | null
  source: LaneSampleSource
  sampledAt: string
  version: number
  /** `'YYYY-MM'` of `date` — the reporting index's hash key (Step I). */
  sampleMonth?: string | null
  customerRepId?: string | null
  carrierRepId?: string | null
  teamKey?: string | null
  invoiceId?: string | null
  /** `'YYYY-MM'` of the order's `invoicedAt`. */
  invoiceMonth?: string | null
  // Step R — the Brokerage dashboard's grouping and its tracking / POD history
  revDivision?: string | null
  revSubdivision?: string | null
  salesRepId?: string | null
  deliveredAt?: string | null
  /** When the POD document landed; with `deliveredAt` this is POD collection time. */
  podReceivedAt?: string | null
  trackingProvider?: string | null
  /** First position report of any kind, for "time to first ping". */
  firstPingAt?: string | null
  datPostedAt?: string | null
  /** Check calls the schedule asked for, and how many landed — compliance share. */
  checkCallsDue?: number | null
  checkCallsMet?: number | null
  createdAt?: string
  updatedAt?: string
}

/** The quotes half of `TmsSettings`, as the settings card edits it. */
export interface QuoteSettings {
  hoursToQuote?: number | null
  offerExpiryHours?: number | null
  quoteNumberFormat?: string | null
  nextQuoteNumber?: number | null
  quoteEmailTemplate?: string | null
  counterEmailTemplate?: string | null
  offerRequestEmailTemplate?: string | null
  quoteTermsText?: string | null
  quoteBelowMinMarginAdminOnly?: boolean | null
  quoteOffersCarrierSeesBookNow?: boolean | null
}

/** One stop, as the public quote page is allowed to see it. */
export interface QuotePublicStop {
  type: string
  city?: string | null
  state?: string | null
  appt?: string | null
  apptType?: string | null
  sequence: number
}

/** One priced line, as a customer sees it: a label and an amount, nothing else. */
export interface QuotePublicLine {
  label: string
  amountCents: number
}

/**
 * What the public page may say. Built by an allow-list in `quotePublicView`, never
 * by deleting fields off the row: a field added to `QuoteRecord` tomorrow cannot
 * leak by being forgotten here.
 */
export interface QuotePublicView {
  side: QuoteSide
  quoteNumber: string
  status: QuoteStatus
  brokerName: string
  expiresAt?: string | null
  expired: boolean
  /** Whose move it is, in the public page's words. */
  awaiting: 'YOU' | 'US' | 'NONE'
  stops: QuotePublicStop[]
  mode?: string | null
  equipmentType?: string | null
  equipmentLengthFt?: number | null
  commodity?: string | null
  weightLbs?: number | null
  miles?: number | null
  /** SELL: our price to the customer. BUY: what we offer the carrier. */
  amountCents: number
  /** SELL only: the lines behind the amount. */
  lines: QuotePublicLine[]
  /** BUY only: the number the carrier may accept outright, when enabled. */
  bookNowRateCents?: number | null
  /** BUY only: the carrier's own last number, so they see what they said. */
  theirAmountCents?: number | null
  message?: string | null
  terms?: string | null
  rounds: number
  generatedAt: string
}

/** One side's statistics over a lane's samples. */
export interface LaneStatsSide {
  count: number
  lowCents: number | null
  medianCents: number | null
  avgCents: number | null
  highCents: number | null
  /** Average cents per mile, over the samples that carry miles. */
  perMileCents: number | null
}

export interface LaneStatsMonth {
  month: string
  customerAvgCents: number | null
  carrierAvgCents: number | null
  count: number
}

export interface LaneStats {
  customer: LaneStatsSide
  carrier: LaneStatsSide
  marginAvgBps: number | null
  milesAvg: number | null
  byMonth: LaneStatsMonth[]
  lastAt: string | null
}

export type LaneStatsWindow = 90 | 180 | 365 | 'ALL'

export interface LaneStatsFilters {
  windowDays?: LaneStatsWindow
  equipmentType?: string | null
  rateType?: RateType | null
  /** Own-fleet legs carry `costCents: 0`; counting them would drag a lane to zero. */
  includeOwnFleetCost?: boolean
}

// ── Step I — staff, roles, teams, commissions and reporting ──────────────────

/** The six TMS roles plus NONE (own-fleet-only staff, and anyone not assigned yet). */
export type RoleKey =
  | 'ADMIN'
  | 'MANAGER'
  | 'CUSTOMER_REP'
  | 'CARRIER_REP'
  | 'AR_AP'
  | 'COMPLIANCE'
  | 'NONE'

/** Per-user "additional permissions". Only some of these are enforced server-side. */
export type ClaimKey =
  | 'CREDIT_LIMIT_EDIT'
  | 'AR_POSTING'
  | 'AP_POSTING'
  | 'AP_APPROVAL'
  | 'CARRIER_STATUS_EDIT'
  | 'AR_CHARGES'
  | 'AP_CHARGES'
  | 'CARRIER_INSURANCE_EDIT'
  | 'NO_AR_INVOICE'

export type UserStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE'

/**
 * One staff login. `id` IS the Cognito username (the e-mail for everyone invited
 * through the Users page), which is what every rep field on an order, load,
 * customer or carrier already holds.
 */
export interface UserProfileRecord {
  id: string
  email: string
  name?: string | null
  role?: RoleKey | null
  teamKeys?: string[] | null
  managerId?: string | null
  claims?: string[] | null
  /** Page keys granted on top of the role — the mirror of the `page-*` groups. */
  extraPages?: string[] | null
  status?: UserStatus | null
  title?: string | null
  phone?: string | null
  datEmail?: string | null
  invitedAt?: string | null
  invitedBy?: string | null
  lastRoleChangeAt?: string | null
  lastRoleChangeBy?: string | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt?: string
  updatedAt?: string
}

/** The five sender slots a team can own (stored now, wired to SES in J/L). */
export interface TeamSenderAddresses {
  shipment?: string | null
  rateCon?: string | null
  quoteReply?: string | null
  customerInvoice?: string | null
  remittance?: string | null
}

export interface Team {
  key: string
  name: string
  memberIds: string[]
  senderAddresses?: TeamSenderAddresses | null
  /** Print the team's contact on the public tracking page instead of the rep's. */
  showContactOnTracking?: boolean | null
  active?: boolean | null
}

// ── Commissions ──────────────────────────────────────────────────────────────

/** Who gets paid, resolved from the people already named on the records. */
export type CommissionRoleName =
  | 'PRIMARY_ACCOUNT_OWNER'
  | 'SECONDARY_ACCOUNT_OWNER'
  | 'PRIMARY_CARRIER_REP'
  | 'SECONDARY_CARRIER_REP'
  | 'PRIMARY_OPERATED_BY'
  | 'SECONDARY_OPERATED_BY'
  | 'CARRIER_BOOKING_REP'
  | 'CREATED_BY'
  | 'MANAGER'
  | 'SPECIFIC_USER'

export type CommissionRateType = 'FIXED' | 'PERCENT_PROFIT' | 'PERCENT_REVENUE'

/**
 * READY_TO_INVOICE is deliberately not offered: at UNBILLED nothing is frozen,
 * and a commission on a number that can still change is a number that will be wrong.
 */
export type CommissionTrigger = 'GENERATE_INVOICE' | 'INVOICE_PAID'

export type CommissionTierType = 'PER_LOAD_MARGIN_BPS' | 'PER_LOAD_PROFIT_CENTS'

export type CommissionStatus =
  | 'UN_APPROVED'
  | 'REP_COUNTERED'
  | 'MANAGER_COUNTERED'
  | 'MANAGER_APPROVED'
  | 'FULLY_APPROVED'
  | 'PAID'
  | 'CANCELLED'

export type CommissionKind = 'EARNED' | 'ADJUSTMENT' | 'REVERSAL'

export type CommissionBasisKind = 'REVENUE' | 'PROFIT' | 'FIXED'

export type CommissionSource = 'RUN' | 'RERUN' | 'VOID' | 'WRITE_OFF' | 'OVERRIDE'

export interface CommissionTier {
  /** Lower bound of the band, in the tier type's own unit. Ascending, first is 0. */
  fromBps?: number | null
  fromCents?: number | null
  rateBps?: number | null
  rateCents?: number | null
  label?: string | null
}

export interface CommissionPlanRole {
  roleName: CommissionRoleName
  rateType: CommissionRateType
  rateBps?: number | null
  rateCents?: number | null
  /** Share of the role's amount for each person when a role resolves to several. */
  splitBps?: number | null
  /** Named people, for SPECIFIC_USER. */
  userIds?: string[] | null
  tierType?: CommissionTierType | null
  /** True: each band pays its own rate on its own slice. False: one rate on the whole. */
  graduated?: boolean | null
  tiers?: CommissionTier[] | null
}

export interface CommissionPlanScope {
  userIds?: string[] | null
  customerIds?: string[] | null
  teamKeys?: string[] | null
}

export interface CommissionPlan {
  id: string
  name: string
  active?: boolean | null
  effectiveFrom?: string | null
  effectiveTo?: string | null
  /** Which date decides whether an order falls in the plan's window. */
  dateField?: 'INVOICED' | 'DELIVERED' | null
  scope?: CommissionPlanScope | null
  roles: CommissionPlanRole[]
}

export type PayScheduleFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY'

export interface CommissionPaySchedule {
  frequency: PayScheduleFrequency
  /** 0–6 for WEEKLY/BIWEEKLY (0 = Sunday); 1–28 for MONTHLY; ignored for SEMI_MONTHLY. */
  payDay?: number | null
  /** Days after the period ends before it is paid. */
  daysUntilPay?: number | null
  /** The Monday a BIWEEKLY cadence counts from. */
  anchorDate?: string | null
}

/** One entry in a commission row's own history. */
export interface CommissionEvent {
  at: string
  by: string
  action: string
  note?: string | null
  amountCents?: number | null
}

export interface CommissionRecord {
  id: string
  kind?: CommissionKind | null
  /** The EARNED row an ADJUSTMENT or REVERSAL answers. */
  adjustsId?: string | null
  orderId: string
  shipmentId?: string | null
  shipmentNumber?: string | null
  invoiceId: string
  invoiceNumber?: string | null
  customerId?: string | null
  customerName?: string | null
  carrierId?: string | null
  carrierName?: string | null
  divisionKey?: string | null
  teamKey?: string | null
  repId: string
  repName?: string | null
  managerId?: string | null
  roleName: CommissionRoleName
  planId?: string | null
  planName?: string | null
  rateType?: CommissionRateType | null
  rateBps?: number | null
  rateCents?: number | null
  tierLabel?: string | null
  splitBps?: number | null
  basis?: CommissionBasisKind | null
  basisCents: number
  revenueCents: number
  costCents: number
  profitCents: number
  marginBps?: number | null
  /** What the plan says. Never erased by an override or a counter. */
  amountCents: number
  overrideCents?: number | null
  overrideBy?: string | null
  overrideNote?: string | null
  /** What is actually owed: override ?? accepted counter ?? amount. */
  netCents: number
  /** e.g. `'OWN_FLEET_NO_COST'` or `'NO_PERSON'`. */
  basisNote?: string | null
  needsReview?: boolean | null
  /** Every carrier assignment is finalized (or own-asset), so the cost cannot move. */
  costFinal?: boolean | null
  status?: CommissionStatus | null
  counterCents?: number | null
  counterBy?: string | null
  counterNote?: string | null
  approvedAt?: string | null
  approvedBy?: string | null
  cancelledAt?: string | null
  cancelReason?: string | null
  trigger?: CommissionTrigger | null
  triggerAt: string
  commissionMonth: string
  payPeriodId?: string | null
  paidAt?: string | null
  paymentRef?: string | null
  source?: CommissionSource | null
  computedAt: string
  events?: CommissionEvent[] | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt?: string
  updatedAt?: string
}

export type CommissionPayPeriodStatus = 'OPEN' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID'

export interface CommissionPayPeriodRepRow {
  repId: string
  repName?: string | null
  count: number
  amountCents: number
  statementKey?: string | null
}

export interface CommissionPayPeriodRecord {
  id: string
  periodStart: string
  periodEnd: string
  payDate: string
  status?: CommissionPayPeriodStatus | null
  commissionCount?: number | null
  totalCents?: number | null
  byRep?: CommissionPayPeriodRepRow[] | null
  submittedAt?: string | null
  submittedBy?: string | null
  approvedAt?: string | null
  approvedBy?: string | null
  paidAt?: string | null
  paidBy?: string | null
  paymentRef?: string | null
  note?: string | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt?: string
  updatedAt?: string
}

/** The commissions half of `TmsSettings`, as the settings card edits it. */
export interface CommissionSettings {
  commissionsEnabled?: boolean | null
  commissionTrigger?: CommissionTrigger | null
  commissionPlans?: CommissionPlan[] | null
  commissionPaySchedule?: CommissionPaySchedule | null
  commissionApprovalAdminOnly?: boolean | null
  commissionPayAdminOnly?: boolean | null
}

/** The shipment half of `TmsSettings`, as the settings card edits it. */
export interface ShipmentSettings {
  shipmentPrefix?: string | null
  nextShipmentNumber?: number | null
  cancelDeleteAdminOnly?: boolean | null
  defaultMode?: ShipmentMode | null
  arUnbilledStage?: string | null
  apInReviewStage?: string | null
}

// ── Reporting ────────────────────────────────────────────────────────────────

export type ReportGroupBy =
  | 'REP'
  | 'CUSTOMER'
  | 'CARRIER'
  | 'DIVISION'
  | 'TEAM'
  | 'MODE'
  | 'EQUIPMENT'
  | 'MONTH'

export interface ReportFilters {
  divisionKey?: string | null
  teamKey?: string | null
  repId?: string | null
  customerId?: string | null
  carrierId?: string | null
  mode?: string | null
  equipmentType?: string | null
}

export interface ReportRow {
  key: string
  label: string
  loads: number
  revenueCents: number
  costCents: number
  profitCents: number
  marginBps: number | null
  miles: number
  rpmCents: number | null
  cpmCents: number | null
  /** Loads run on our own trucks: counted in revenue, their cost lives in settlements. */
  ownFleet: number
}

export interface ProfitReport {
  rows: ReportRow[]
  totals: ReportRow
  /** Samples skipped because they were canceled or TONU'd. */
  excluded: number
}

// ── Revenue ownership & department views (Step R) ─────────────────────────────
/*
 * Who owns a shipment is data, not code: an admin edits the division tree and the
 * ordered rules that tag a shipment, so BCAT can add a business or a subsidiary —
 * or another company can define its own parties — without a deploy.
 */

/** A hand tag beats every rule and survives a carrier, driver or customer change. */
export type RevTagSource = 'HAND' | 'RULE'

/** Which party owns each part of a division's work. Null = inherit from the parent. */
export interface OwnershipOwners {
  building?: string | null
  booking?: string | null
  tracking?: string | null
  invoicing?: string | null
  carrierPay?: string | null
  settlements?: string | null
}

/** Which existing views a division's shipments flow into. */
export interface OwnershipFlows {
  calendar?: boolean
  dispatch?: boolean
  driverApp?: boolean
  driverPay?: boolean
  fleetDashboards?: boolean
  carShipping?: boolean
}

/** One business or subsidiary. `id` is the code, so a rename never orphans a shipment. */
export interface OwnershipDivisionRecord {
  id: string
  code: string
  name: string
  /** Shown in brackets beside the section name in the sidebar. */
  brand: string | null
  /** Null = a top-level business; set = a subsidiary, at any depth. */
  parentId: string | null
  color: string | null
  sortOrder: number
  active: boolean
  owners: OwnershipOwners | null
  flows: OwnershipFlows | null
  createdBy: string
  updatedBy: string
  version: number
  createdAt: string
  updatedAt: string
}

export type OwnershipConditionKind =
  | 'ALWAYS'
  | 'CARRIER_IS'
  | 'DRIVER_FLEET_GROUP_IS'
  | 'DRIVER_TYPE_IS'
  | 'DRIVER_PROGRAM_IS'
  | 'CUSTOMER_IS'
  | 'EQUIPMENT_IS'
  | 'MODE_IS'
  | 'LOAD_SOURCE_IS'
  | 'REFERENCE_MATCHES'

/**
 * `CARRIER_IS`: a Carrier id, or the reserved `OWN_FLEET` (there is no Carrier row
 * for the own fleet — it is `LoadCarrier.kind === 'OWN_ASSET'`).
 * `CUSTOMER_IS`: a customer id. `REFERENCE_MATCHES`: a regex source, matched
 * case-insensitively against every order reference value. `ALWAYS`: value null.
 */
export interface OwnershipCondition {
  kind: OwnershipConditionKind
  value: string | null
}

/** An ordered rule. First active rule whose condition matches wins. */
export interface OwnershipRuleRecord {
  id: string
  name: string | null
  sortOrder: number
  active: boolean
  condition: OwnershipCondition
  divisionCode: string
  createdBy: string
  updatedBy: string
  version: number
  createdAt: string
  updatedAt: string
}

export type ShipmentViewPickupWindow =
  | 'today'
  | 'tomorrow'
  | 'today_tomorrow'
  | 'this_week'
  | 'this_month'
  | 'last_30_days'

export type ShipmentViewCarrierType = 'OWN_FLEET' | 'CARRIER' | 'NEED_TO_COVER'

export type ShipmentViewDocsState = 'POD_MISSING' | 'DOCS_NEEDED' | 'COMPLETE'

export type ShipmentViewTrackingState = 'TRACKED' | 'UNTRACKED' | 'OVERDUE'

/** Every clause is optional; an absent clause filters nothing. */
export interface ShipmentViewFilters {
  divisions?: string[]
  subdivisions?: string[]
  statuses?: ShipmentStatus[]
  carrierType?: ShipmentViewCarrierType | null
  repId?: string | null
  pickupWindow?: ShipmentViewPickupWindow | null
  docsState?: ShipmentViewDocsState | null
  trackingState?: ShipmentViewTrackingState | null
  arStatuses?: ArStatus[]
  apStatuses?: ApStatus[]
  quoteToBooked?: boolean
  search?: string | null
}

/** Null or empty means everyone who can open Shipments. */
export interface ShipmentViewAudience {
  groups?: string[]
  roles?: string[]
  /** Informational: it groups the view in the sidebar, it never hides it. */
  divisions?: string[]
}

export interface ShipmentViewSort {
  key: string
  dir: 'asc' | 'desc'
}

/** A saved slice of the Shipments page. `id` is the slug. */
export interface ShipmentViewRecord {
  id: string
  slug: string
  name: string
  department: string | null
  description: string | null
  filters: ShipmentViewFilters
  columns: string[] | null
  sort: ShipmentViewSort | null
  isDefault: boolean
  audience: ShipmentViewAudience | null
  sortOrder: number
  active: boolean
  createdBy: string
  updatedBy: string
  version: number
  createdAt: string
  updatedAt: string
}

/**
 * The row shape a view's filters read. The Shipments page maps its own rows onto
 * it, so the filter code never has to know how the board assembles a row.
 */
export interface ShipmentViewRow {
  id: string
  status: ShipmentStatus
  revDivision: string | null
  revSubdivision: string | null
  assignmentType: AssignmentType | null
  salesRepId: string | null
  customerRepId: string | null
  pickupAppt: string | null
  docsMissing: string[]
  arStatus: ArStatus | 'LEGACY' | null
  apStatus: ApStatus | null
  trackingProvider: string | null
  nextCheckCallAt: string | null
  lastCheckCallAt: string | null
  quoteId: string | null
  searchKey: string | null
  voidedAt: string | null
}
