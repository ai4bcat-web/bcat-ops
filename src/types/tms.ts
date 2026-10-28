// `Stop` lives in ./index, which imports Address and the step-B stop fields from
// here. Type-only in both directions, so the cycle never reaches runtime.
import type { Stop } from './index'

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

/** Who moved a load's status last — the driver app and check calls write their own. */
export type LoadStatusSource = 'USER' | 'DRIVER_APP' | 'CHECK_CALL' | 'BACKFILL'

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
