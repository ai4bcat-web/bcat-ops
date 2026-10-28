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

export type ArStatus = 'DOCS_NEEDED' | 'UNBILLED' | 'UNPAID' | 'PAID' | 'INVOICE_NOT_NEEDED'

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

export type ShipmentNoticeKind = 'MILESTONE' | 'POD_REQUEST' | 'DOCUMENTS'

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
