import { type ClientSchema, a, defineData } from '@aws-amplify/backend'
import { userManagement } from '../functions/userManagement/resource'
import { slackStatusNotifier } from '../functions/slack-status-notifier/resource'
import { onboardingEmailer } from '../functions/onboarding-emailer/resource'
import { driverPayEmailer } from '../functions/driver-pay-emailer/resource'
import { tripScreenshotParser } from '../functions/trip-screenshot-parser/resource'
import { rateconParser } from '../functions/ratecon-parser/resource'
import { apptRequestEmailer } from '../functions/appt-request-emailer/resource'
import { vehicleQuoteEmailer } from '../functions/vehicle-quote-emailer/resource'
import { googleReviews } from '../functions/google-reviews/resource'
import { apptNeedNotifier } from '../functions/appt-need-notifier/resource'
import { vendorApActions } from '../functions/vendor-ap-actions/resource'
import { tmsDirectoryActions } from '../functions/tms-directory-actions/resource'
import { tmsShipmentActions } from '../functions/tms-shipment-actions/resource'
import { tmsGeocode } from '../functions/tms-geocode/resource'
import { podActions } from '../functions/pod-actions/resource'
import { otrActions } from '../functions/otr-actions/resource'
import { dispatchActions } from '../functions/dispatch-actions/resource'
import { tmsCarrierActions } from '../functions/tms-carrier-actions/resource'
import { tmsTrackingActions } from '../functions/tms-tracking-actions/resource'

// ExpenseCategory and ExpenseEntryMethod enums are defined inline on each
// model field — Amplify Gen 2 does not require top-level enum declarations.

const schema = a.schema({
  Load: a
    .model({
      aljexId:         a.string().required(),
      tmsId:           a.string().required(),
      pickupNumber:    a.string().required(),
      originName:      a.string(),
      originCity:      a.string(),
      destinationName: a.string(),
      destinationCity: a.string(),
      pickupAppt:      a.string().required(),
      pickupApptEnd:   a.string(),
      pickupApptType:  a.string(),
      deliveryAppt:    a.string().required(),
      deliveryApptEnd: a.string(),
      deliveryApptType: a.string(),
      pickupDriverId:  a.string(),
      deliveryDriverId: a.string(),
      readyToInvoice:  a.boolean().required(),
      rateConfirmKey:  a.string(),

      truckId:         a.string(),
      rate:            a.integer(),
      miles:           a.integer(),
      customer:        a.string(),
      colorKey:        a.string(),   // load color swatch (driver-1…driver-12, broker)
      daySlot:         a.integer(),  // MANUAL number badge — independent label, no effect on order
      sortOrder:       a.float(),    // persisted drag-reorder position within a day (hidden; drives sort)
      notes:           a.string(),   // short free-text notes
      // Why this load's POD is what it is ("BOL is one page, no page 2"), written when the POD
      // is reviewed on the PODs page and shown with the load's paperwork.
      podNotes:        a.string(),
      hot:             a.boolean(),  // urgent/"hot" load — flagged with 🔥 in schedule
      // ELD oversight: a run outside the 150 air-mile radius needs logs, and somebody has
      // to confirm they were kept. Set from the fleet manager dashboard. See src/lib/eldMonitor.ts.
      // What is on the truck, read off the rate confirmation when the load is built.
      commodity:       a.string(),
      weight:          a.integer(),            // pounds
      pieces:          a.integer(),            // count of piecesUnit
      piecesUnit:      a.string(),             // pallets | cases | pieces | skids | rolls | bundles
      // The trailer carrying the load, named by the driver as they leave the pickup.
      trailerNumber:   a.string(),
      // Where the pickup's paperwork went at end of day: { kind: TRUCK|SHED|TRAILER, unit, at, byDriverId, byName }
      paperworkLocation: a.json(),
      eldLogsReviewedAt: a.datetime(),
      eldLogsReviewedBy: a.string(),
      eldLogsNote:       a.string(),
      unscheduled:     a.boolean(),  // true = orphan (no firm date) → parked in the calendar's Unscheduled lane
      // Phase 1: link loads to the directory Customer. The `customer` string remains the
      // booked-name snapshot; customerId is the authoritative link. Backfill sets both.
      customerId:      a.string(),
      // Canonical multi-stop array: Stop[] (see src/lib/stops.ts). The legacy pickup*/
      // delivery*/origin*/destination*/*DriverId fields above are dual-written mirrors
      // derived from stops (first pickup → pickup*, last delivery → delivery*).
      stops:           a.json(),

      // ── Shipment / Order / Load (Step B) ─────────────────────────────────
      // Additive only. A Load with no `status` is a legacy own-fleet row: the
      // calendar, /loads, settlements, the driver app, PODs and factoring all keep
      // reading `rate`/`readyToInvoice`/`stops`/the driver fields above untouched.
      shipmentId:      a.string(),   // parent Shipment (movement)
      orderId:         a.string(),   // the Order this leg bills against
      loadNumber:      a.string(),   // `<shipment number>-<leg>`
      leg:             a.integer(),  // 1-based leg within the shipment
      status: a.enum([
        'SOURCING', 'BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP',
        'IN_TRANSIT', 'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY',
        'UNLOADING', 'DELIVERED', 'INVOICING', 'CANCELED',
      ]),
      statusChangedAt: a.datetime(),
      statusChangedBy: a.string(),
      // SYSTEM: a stop time stamped by something that is not a person and not the
      // driver app — the POD close, the dispatch MMS auto-POD — projected onto
      // status by load-tracking-projector (Step D).
      statusSource:    a.enum(['USER', 'DRIVER_APP', 'CHECK_CALL', 'BACKFILL', 'SYSTEM']),
      carrierRepId:    a.string(),   // Cognito username of the rep covering the load
      assignmentType:  a.enum(['OWN_ASSET', 'CARRIER', 'NEED_TO_COVER']),
      activeLoadCarrierId: a.string(),  // the ACTIVE LoadCarrier row, if any
      carrierName:     a.string(),   // snapshot of the active carrier's name
      equipmentType:   a.string(),
      divisionKey:     a.string(),
      trackingProvider: a.enum(['NONE', 'MANUAL', 'LINK', 'DRIVER_APP', 'MOTIVE']),
      nextCheckCallAt: a.datetime(),
      nextCheckCallNote: a.string(),
      // Sparse marker: the literal 'OPEN' only while a check call is outstanding, so
      // the checkCallOpen index holds the worklist and nothing else.
      checkCallOpen:   a.string(),
      pickupMonth:     a.string(),   // 'YYYY-MM' of the first pickup, for month boards
      // What the freight is worth. Checked against the carrier's cargo policy
      // limit when a load is booked out — cents, like every other money field.
      cargoValueCents: a.integer(),

      // ── Tracking & check calls (Step D) ─────────────────────────────────
      // Denormalised "last update" strip for the board and the Tracking tab, so
      // neither has to read the LoadCheckCall log to say where the freight is.
      lastCheckCallAt:   a.datetime(),
      lastCheckCallType: a.string(),
      lastKnownAt:       a.datetime(),
      lastKnownCity:     a.string(),
      lastKnownState:    a.string(),
      lastKnownLat:      a.float(),
      lastKnownLng:      a.float(),
      lastKnownSource:   a.enum(['MANUAL', 'DRIVER_APP', 'LINK', 'MOTIVE', 'SYSTEM']),
      // Open INCIDENT rows on this load. F reads it; D only keeps it honest.
      openIncidentCount: a.integer(),
      deliveredAt:       a.datetime(),
      // Stamped by check-call-notifier so one schedule nags once per state.
      // Rescheduling moves nextCheckCallAt past them and re-arms both.
      checkCallDueNotifiedAt:     a.datetime(),
      checkCallOverdueNotifiedAt: a.datetime(),
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
    })
    .secondaryIndexes((index) => [
      index('customerId'),
      // Step B board queries: one shipment's legs, the status tabs, and the
      // outstanding check-call worklist (sparse — only rows with checkCallOpen set).
      // Status is deliberately not sorted by pickupAppt: own-fleet saves often
      // write '' for undated stops, and DynamoDB GSI sort keys cannot be empty.
      index('shipmentId'),
      index('status'),
      index('checkCallOpen').sortKeys(['nextCheckCallAt']),
    ])
    .authorization((allow) => [
      // Phase 1: Load remains userPool-editable; merge repoints use schema-level IAM auth.
      allow.authenticated(),
    ]),

  Driver: a
    .model({
      name:               a.string().required(),
      phone:              a.string().required(),
      active:             a.boolean().required(),
      type:               a.string(),
      colorKey:           a.string(),
      notes:              a.string(),
      photoKey:           a.string(),
      assignedTruckId:    a.string(),
      // Equipment.id of the trailer this driver pulls. Null = not yet assigned ("TBD"),
      // which is the normal state until trailers are handed out.
      assignedTrailerId:  a.string(),
      // Which fleet this driver runs in. Mirrors DriverPaySetting.payGroup so the two
      // agree, and decides which documents their file requires (see src/lib/fileHub.ts).
      // OWNER_OPERATOR is a driver-only value: trucks stay LOCAL/AMAZON/BOX_TRUCK.
      fleetGroup:         a.enum(['LOCAL', 'AMAZON', 'BOX_TRUCK', 'OWNER_OPERATOR']),
      // Compliance & profile fields
      email:              a.string(),   // invite target; required for new drivers (enforced in Zod)
      cdl:                a.string(),   // CDL number e.g. "CDL-A IL-8823901"
      cdlExpiration:      a.string(),   // YYYY-MM-DD
      medCardExpiration:  a.string(),   // YYYY-MM-DD
      drugTestDate:       a.string(),   // YYYY-MM-DD — last test date
      hireDate:           a.string(),   // YYYY-MM-DD
      // DOT onboarding / compliance classification.
      // driverType was previously a free-form string ('company'|'owner_op'); it is now an
      // enum. Existing un-reclassified records read as null → shown as "Unclassified" in UI.
      driverType:         a.enum(['COMPANY', 'OWNER_OPERATOR']),
      // ARCHIVED = candidate set aside / not currently being considered (reversible).
      onboardingStatus:   a.enum(['NOT_STARTED', 'INVITED', 'IN_PROGRESS', 'PENDING_REVIEW', 'COMPLETE', 'ARCHIVED']),
      complianceStatus:   a.enum(['COMPLIANT', 'EXPIRING_SOON', 'NON_COMPLIANT', 'UNKNOWN']), // cached, updated by scanner
      // Phased onboarding template in effect for this driver (e.g. Amazon Relay). Optional:
      // legacy/Ivan/Local drivers read null and keep the flat (non-phased) checklist behavior.
      onboardingTemplateId: a.string(),
      /*
       * This driver's Motive user id, set by staff — never inferred.
       *
       * It decides whose hours-of-service log the driver app shows, and duty status is a
       * federal record, so a near-miss is not acceptable: Motive carries "Chuck Best" where
       * we carry "Charles Best", and TWO accounts called "Jason Smith". Name matching can
       * only suggest a link for a human to confirm — see src/lib/motiveDriverMatch.ts.
       */
      motiveDriverId:     a.integer(),
      /*
       * May this driver record PTO on their time card?
       *
       * A flag rather than a list of names in the code: who accrues PTO is an employment
       * decision that changes, and a name hardcoded in a component is the kind of thing
       * nobody finds when it does. Today only Jason Smith and Charles Best have it.
       */
      ptoEligible:        a.boolean(),
      /*
       * The dispatcher who owns this driver's conversation, and who covers when they are
       * out. Staff emails. A new Dispatch conversation from the driver is assigned to the
       * primary automatically; both are invited to the driver's Slack channel by default.
       */
      dispatcherPrimary:  a.string(),
      dispatcherBackup:   a.string(),
      /*
       * Which app a driver gets is normally decided by fleet (see src/lib/driverProgram.ts).
       * ivanApp forces the Ivan paperwork app for someone outside that fleet; timeClock
       * turns the Hours tab on or off regardless of fleet.
       */
      ivanApp:            a.boolean(),
      timeClock:          a.boolean(),
      // What they pull: DRY_VAN | FLATBED | POWER_ONLY. Blank means by fleet (Ivan local = dry van).
      unitType:           a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  /*
   * One stretch of an employee driver's day: a clock-in/out pair, a paid holiday, or PTO.
   *
   * Several rows per day is normal — a driver clocks out for lunch and back in — so the
   * day's hours are the SUM of its rows, never one row's span. Minutes are stored rather
   * than recomputed from the timestamps on every read, because a staff correction may set
   * hours that the raw times no longer explain (a missed clock-out, a forgotten break), and
   * the corrected figure is the one payroll uses.
   *
   * Ivan's own drivers only. Owner operators are settled on a percentage and do not clock.
   */
  TimeClockEntry: a
    .model({
      driverId:    a.id().required(),
      /** Chicago calendar day, YYYY-MM-DD. The day owns the row, not the timestamp. */
      workDate:    a.string().required(),
      kind:        a.enum(['WORK', 'HOLIDAY', 'PTO']),
      /** ISO. Null on HOLIDAY/PTO rows, which are a number of hours and no clock. */
      clockInAt:   a.string(),
      /** ISO. Null while the driver is still clocked in — that is an open shift. */
      clockOutAt:  a.string(),
      /** Paid minutes for this row. The figure payroll uses. */
      minutes:     a.integer(),
      note:        a.string(),
      /** Who entered it. A driver's own clock, or staff adding/fixing it for them. */
      source:      a.enum(['DRIVER', 'STAFF']),
      /** Truck on file at clock in, and its odometer at each punch — the yard legs of loaded-vs-empty miles. */
      truckId:         a.string(),
      clockInOdometer: a.float(),
      clockOutOdometer: a.float(),
      /*
       * Corrections are recorded, never silent. Staff are the only ones who may change a
       * row after the fact, and the original minutes are kept beside the new figure so a
       * disagreement about a paycheck can be settled by looking.
       */
      correctedBy:      a.string(),
      correctedAt:      a.string(),
      originalMinutes:  a.integer(),
    })
    .secondaryIndexes((index) => [
      index('driverId').sortKeys(['workDate']),
      index('workDate'),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Fleet (trucks & trailers) ──────────────────────────────────────────────
  // Enum-like fields are stored as plain strings to match the frontend types
  // verbatim (e.g. 'truck'|'trailer', 'owned'|'leased') — no case conversion.
  Equipment: a
    .model({
      type:                    a.string().required(),  // 'truck' | 'trailer'
      unitNumber:              a.string().required(),
      nickname:                a.string(),
      vin:                     a.string(),
      plate:                   a.string(),
      make:                    a.string(),
      model:                   a.string(),
      year:                    a.integer(),
      mileage:                 a.integer(),
      ownership:               a.string(),             // 'owned' | 'leased' | 'rented' | 'financed'
      insured:                 a.boolean(),
      active:                  a.boolean(),
      // The day the truck was parked (YYYY-MM-DD), set by Mark inactive on the Trucks page.
      // Its insurance stops counting; plates/ELD kept on it sit in the holding area.
      inactiveSince:           a.string(),
      // Motive "Share Live Location" link for this truck, pasted once; the dashboard copies it.
      trackingUrl:             a.string(),
      // Code behind this truck's permanent BCAT tracking link (/track/<code>); regenerate to revoke.
      trackingCode:            a.string(),
      dotInspectionDate:       a.string(),             // YYYY-MM-DD
      iftaExpirationDate:      a.string(),
      irpExpirationDate:       a.string(),
      insuranceExpirationDate: a.string(),
      bobtailInsuranceDate:    a.string(),
      assignedDriverId:        a.string(),
      fleetManagerAssignee:    a.string(),
      onTollwayAccount:        a.boolean(),
      fuelCardNumbers:         a.string().array(),     // EFS card # prefixes
      // ELD / telematics source: 'motive' = auto-synced by unit # (default);
      // 'manual' = own ELD, excluded from Motive mileage sync. null = treated as motive.
      eldSource:               a.string(),
      eldSerialNumber:         a.string(),             // own-ELD device serial (manual trucks)
      // Motive vehicle number when it differs from unitNumber — e.g. the ELD carried
      // over from a retired truck still reports under the old number. null = unitNumber.
      motiveVehicleNumber:     a.string(),
      // Fleet grouping for profitability — LOCAL (Ivan) vs AMAZON. Optional: legacy
      // records read null and are treated as "ungrouped" by the profitability view.
      // This is the SOURCE OF TRUTH for fleet membership (no hardcoded unit lists).
      fleetGroup:              a.enum(['LOCAL', 'AMAZON', 'BOX_TRUCK']),
      // Preventive-maintenance (PM) tracking — Ivan/LOCAL fleet runs a PM every 25k mi.
      // lastPmMileage is the odometer reading at the last PM service; the Fleet Manager
      // Dashboard counts down to the next PM (lastPmMileage + 25000) using live mileage.
      lastPmDate:              a.string(),   // YYYY-MM-DD of the last PM service
      lastPmMileage:           a.integer(),  // odometer at the last PM
      notes:                   a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Driver pay periods (biweekly) ──────────────────────────────────────────
  // Manual gross-pay entry now; `source` is the Paychex integration seam. A driver's
  // pay is mapped to their truck via Driver.assignedTruckId and spread (prorated by
  // day) across the weeks of the requested range in the profitability calc layer.
  DriverPayPeriod: a
    .model({
      driverId:    a.string().required(),
      periodStart: a.string().required(),   // YYYY-MM-DD (inclusive)
      periodEnd:   a.string().required(),    // YYYY-MM-DD (inclusive)
      grossPay:    a.float().required(),     // dollars
      source:      a.enum(['MANUAL', 'PAYCHEX']),
      notes:       a.string(),
    })
    .secondaryIndexes((index) => [
      index('driverId').sortKeys(['periodStart']),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Amazon driver pay ──────────────────────────────────────────────────────
  // Weekly (7-day) trip-based pay for Amazon drivers. AmazonTrip = one freight load
  // line; DriverPaySetting = per-driver pay model (% + expense timing + fuel card +
  // fixed weekly deductions); DriverPayDeduction = per-week one-off charges;
  // DriverPayCredit = per-period extra pay (detention, bonus…) added to the check at
  // 100%. Fuel is pulled live from FuelTransaction by the driver's fuel card.
  // See src/lib/driverPay.ts.
  AmazonTrip: a
    .model({
      driverId:      a.string().required(),
      periodStart:   a.string().required(),  // YYYY-MM-DD — start of the 7-day pay week
      loadId:        a.string(),
      origin:        a.string(),
      destination:   a.string(),
      miles:         a.float(),
      equipment:     a.string(),
      freightAmount: a.float().required(),   // dollars (gross freight for this load)
      ratePerMile:   a.float(),
      dispatcher:    a.string(),
      status:        a.string(),             // 'Completed' | 'Active' | 'Cancelled' | …
      notes:         a.string(),
      sortOrder:     a.float(),              // manual drag order within a driver's week
    })
    .secondaryIndexes((index) => [index('periodStart').sortKeys(['driverId'])])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Amazon driver disputes ─────────────────────────────────────────────────
  // A driver-submitted claim that Amazon underpaid / owes money on a trip (detention,
  // TONU, cancellations, etc.). Rows originate from a Google Form → its linked Sheet →
  // an Apps Script that POSTs each submission to the amazon-dispute-intake Lambda, which
  // writes here (source GOOGLE_FORM). Staff can also add rows by hand (source MANUAL).
  // Workflow: PENDING (new) → POSTED (filed with Amazon) → PAID (recovered) | REJECTED.
  AmazonDispute: a
    .model({
      driverName:      a.string().required(),  // "Driver Name"
      tripNumber:      a.string(),             // "What is the Trip Number?"
      shipmentDate:    a.string(),             // "On what day was this shipment?" (YYYY-MM-DD or raw)
      payPeriod:       a.string(),             // "What 7 day period" e.g. "4/19 - 4/25"
      amountPaid:      a.float(),              // "How much was paid on this by Amazon?" (dollars)
      amountRequested: a.float(),              // "What amount should we request from Amazon?" (dollars)
      description:     a.string(),             // "Provide a short description of what happened"
      photoUrl:        a.string(),             // "Upload photos for proof" — Google Drive link
      status:          a.enum(['PENDING', 'POSTED', 'PAID', 'REJECTED']),
      resolvedAmount:  a.float(),              // dollars actually recovered when PAID
      submittedAt:     a.string(),             // ISO — the Google Form timestamp
      source:          a.enum(['GOOGLE_FORM', 'MANUAL', 'DRIVER_PORTAL']),
      externalId:      a.string(),             // dedup key from the form submission
      notes:           a.string(),             // internal staff notes
      // What Amazon came back with when staff worked the dispute (pasted from the
      // Amazon case/email) plus who recorded it and when.
      amazonResponse:   a.string(),
      amazonResponseAt: a.string(),            // ISO — when staff recorded the response
      amazonResponseBy: a.string(),            // staff email
      // AWSJSON array of proof objects: driver uploads from the public portal
      // ({ s3Key, fileName, contentType, size, kind: 'CONFIRMATION' | 'PHOTO' }) plus
      // staff-uploaded Amazon response screenshots (kind 'AMAZON_RESPONSE', stored
      // under dispute-responses/). Kept off the public board.
      evidence:        a.string(),
      // Settlement link — set when staff post a PAID dispute onto a driver's weekly
      // check as a DISPUTE shipment row. The trip id makes re-saving idempotent: the
      // same row is moved or re-priced instead of paying the recovery twice.
      settlementPeriodStart: a.string(),  // YYYY-MM-DD Sunday of the settlement week
      settlementTripId:      a.string(),  // AmazonTrip.id
      settlementDriverId:    a.string(),  // Driver.id whose check carries it
    })
    .secondaryIndexes((index) => [index('externalId')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Archive of uploaded master CSVs (the raw file lives in S3 at s3Key). One row per
  // upload so the source files are kept and downloadable.
  AmazonPayMaster: a
    .model({
      fileName:    a.string().required(),
      periodStart: a.string().required(),   // pay week the upload was filed to
      s3Key:       a.string().required(),
      uploadedAt:  a.string().required(),    // ISO timestamp
      uploadedBy:  a.string(),               // user email
      rowCount:    a.integer(),              // parsed rows in the file
      tripCount:   a.integer(),              // trips actually imported
      driverCount: a.integer(),              // distinct drivers imported
      sizeBytes:   a.integer(),
      notes:       a.string(),
    })
    .secondaryIndexes((index) => [index('periodStart')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Box-truck driver pay (Ivan Cartage) ─────────────────────────────────────
  // Biweekly (14-day Wed→Tue) shipment-based pay for box-truck drivers (e.g. Zak).
  // One row per shipment from the Ivan Cartage "Trips" spreadsheet. Pay reuses the
  // Chad model (% of gross − expenses); gross = Σ grossProfit. See src/lib/driverPay.ts.
  BoxTruckTrip: a
    .model({
      driverId:     a.string().required(),
      periodStart:  a.string().required(),   // YYYY-MM-DD — Wednesday start of the 14-day period
      loadId:       a.string(),              // source Load.id when pulled from the calendar (dedup key)
      date:         a.string(),              // YYYY-MM-DD — the shipment/delivery date
      aljexPro:     a.string(),              // our Aljex PRO # (Load.aljexId)
      proNumber:    a.string(),              // PU / TMS # (Load.pickupNumber / tmsId; or shipment_pro)
      customer:     a.string(),              // customer name
      salesRep:     a.string(),              // sales rep name
      loadDesc:     a.string(),              // shipment_load_des
      customerRate: a.float(),               // shipment_customer_total_rates
      carrierCost:  a.float(),               // shipment_carrier_total_rates
      grossProfit:  a.float().required(),    // gross profit — the pay basis (Load.rate/100 or shipment_gross_profit)
      status:       a.string(),              // 'Delivered' | 'RELEASED' | 'COVERED' | …
      notes:        a.string(),
      sortOrder:    a.float(),               // drag order within a driver's period
    })
    .secondaryIndexes((index) => [index('periodStart').sortKeys(['driverId'])])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  DriverPaySetting: a
    .model({
      driverId:              a.string().required(),
      // OWNER_OPERATOR settles off brokerage loads (rate x percent), not an uploaded
      // trip sheet — see useOwnerOperatorPay. AMAZON stays for the wound-down trip work.
      payGroup:              a.enum(['AMAZON', 'LOCAL', 'BOX_TRUCK', 'OWNER_OPERATOR']),
      payPercent:            a.float().required(),   // 0..1 (e.g. 0.42, 0.88)
      expensesBeforePercent: a.boolean().required(), // true = % applied AFTER expenses (Chad)
      email:                 a.string(),             // where the weekly report is sent
      fuelCardNumber:        a.string(),             // EFS card prefix → pulls weekly fuel
      // Dated card windows [{ from, until, cardNumber }] — pay weeks starting in
      // [from, until) match THAT card instead of fuelCardNumber, so swapping a driver's
      // card never rewrites the fuel on already-paid weeks. Same shape as rateHistory.
      fuelCardHistory:       a.json(),
      // Dated expense revisions [{ label, amount, from, until, revisionId, expenseId,
      // recordedAt/By, endedAt/By }] — prorated by calendar day per settlement; a change
      // ends the old revision and appends a new one, so history is never rewritten.
      fixedExpenses:         a.json(),
      // Pinned past rate windows [{ from, until, payPercent, expensesBeforePercent }] —
      // pay weeks starting in [from, until) use that model instead of the base fields,
      // so changing a driver's current rate never rewrites already-paid history.
      rateHistory:           a.json(),
      active:                a.boolean(),
      notes:                 a.string(),
    })
    .secondaryIndexes((index) => [index('driverId')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  DriverPayDeduction: a
    .model({
      driverId:    a.string().required(),
      periodStart: a.string().required(),  // YYYY-MM-DD — the 7-day pay week
      label:       a.string().required(),
      amount:      a.float().required(),    // dollars deducted (positive)
      date:        a.string(),              // YYYY-MM-DD when incurred (display only)
    })
    .secondaryIndexes((index) => [index('periodStart').sortKeys(['driverId'])])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Extra pay added to a settlement check that didn't come from a shipment's gross
  // profit — detention, layover, bonuses, reimbursements, prior-period corrections.
  // The full amount lands on the check; the driver's pay % is NOT applied to it.
  // reasonCode is a plain string (see src/lib/payCredits.ts) so the code list can grow
  // without a backend redeploy.
  DriverPayCredit: a
    .model({
      driverId:    a.string().required(),
      periodStart: a.string().required(),  // YYYY-MM-DD — start of the pay period it lands on
      // 'CREDIT' (default when null — every pre-existing row) adds to the check at 100%;
      // 'DEBIT' subtracts at 100% AFTER the % model (cash advance, damage, escrow…).
      kind:        a.string(),
      reasonCode:  a.string().required(),  // 'DETENTION' | 'LAYOVER' | 'BONUS' | …
      label:       a.string(),             // free-text note shown next to the reason
      amount:      a.float().required(),   // dollars ADDED to the check (positive)
      // Optional mileage basis for per-mile charges (e.g. LEASE_MILEAGE debits).
      // When present, amount should equal miles * costPerMile; both are nullable so
      // legacy amount-only rows and ordinary credits/debits are unaffected.
      miles:       a.float(),
      costPerMile: a.float(),
      date:        a.string(),             // YYYY-MM-DD when earned (display only)
      loadRef:     a.string(),             // optional Aljex PRO / PU # the credit relates to
      createdBy:   a.string(),             // user email who added it (audit trail)
      notes:       a.string(),
    })
    .secondaryIndexes((index) => [index('periodStart').sortKeys(['driverId'])])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Driver PWA submissions ─────────────────────────────────────────────────
  // Rate confirmations and PODs uploaded by drivers from the mobile PWA. Drivers
  // never touch AppSync; the driver-app-api Lambda writes these rows on their behalf.
  //
  // source distinguishes PWA uploads from email-forwarded rate cons; absent means PWA
  // (historical rows). externalMessageId is the Gmail message id for email-sourced rows
  // and is the idempotency key for the loads inbox bridge.
  DriverSubmission: a
    .model({
      driverId:          a.string().required(), // resolved server-side, never client input
      driverName:        a.string().required(), // snapshot at creation, for email/Slack text
      status:            a.string(),            // 'NEW' | 'NOTIFIED' | 'LINKED' | 'ARCHIVED'
      source:            a.string(),            // 'PWA' | 'EMAIL' | 'STAFF'; absent means PWA (historical rows)
      submittedByEmail:  a.string(),            // staff member who uploaded on the driver's behalf, when source is STAFF
      externalMessageId: a.string(),            // Gmail message id for email-sourced rows; idempotency key
      loadId:            a.string(),            // null until staff links the built load
      referenceNumber:   a.string(),            // scanned or driver-entered load/VRID reference
      note:              a.string(),            // optional free text from the driver
      // Which stop a MISC submission (photos, other paperwork) was taken at, when the
      // driver sent it from a stop on their day sheet. Absent on PODs and rate cons.
      stopId:            a.string(),
      stopLabel:         a.string(),            // "Pickup — Batory Oakley", for the office
      slackChannelId:    a.string(),            // captured from the parent Slack post
      slackMessageTs:    a.string(),            // parent ts — POD replies use this as thread_ts
      emailMessageId:    a.string(),            // RFC-822 msg id of the parent email, with angle brackets
      emailSubject:      a.string(),            // exact parent subject; POD replies use 'Re: ' + this
      notifiedAt:        a.string(),            // ISO timestamp when the parent notify was sent
      // ── The finished document ────────────────────────────────────────────
      // Pages upload one per file so each can be cleaned up as an image. Once they are,
      // they are merged into ONE enhanced PDF and these point at it. That PDF is the
      // version everything downstream uses — the office, the driver, and OTR — because a
      // POD is one document rather than a pile of photos.
      combinedPodKey:     a.string(),
      combinedRateconKey: a.string(),
      combinedAt:         a.string(),
      // ── POD review (the PODs page) ───────────────────────────────────────
      // Every POD from the driver apps is checked by a person before it counts: the right
      // addresses, every page, readable. The automated read below is advice for that person.
      // 'PENDING' (or absent) | 'APPROVED' | 'NEEDS_REPLACEMENT'
      podReviewStatus:    a.string(),
      podReviewNote:      a.string(),
      podReviewedBy:      a.string(),
      podReviewedAt:      a.string(),
      // What the reviewer confirmed, as JSON: { addresses, allPages, legible } booleans.
      podReviewChecks:    a.string(),
      // When the driver was asked for a better POD, and what they were told.
      podReplacementRequestedAt: a.string(),
      podReplacementMessage:     a.string(),
      // The automated read (amplify/functions/pod-actions/podCheck.ts), as JSON.
      // 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'
      podCheckStatus:     a.string(),
      podCheck:           a.string(),
      podCheckedAt:       a.string(),
      podCheckError:      a.string(),
      createdAt:         a.string().required(),
      updatedAt:         a.string(),
    })
    .secondaryIndexes((index) => [
      index('driverId'),
      index('status'),
      index('externalMessageId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  /*
   * Detention times a driver enters for themselves.
   *
   * Ivan's drivers are not settled a percentage, so there is no pay line to hang
   * detention off the way the owner operators have. What they need is a place to record
   * that they sat at a dock, while they still remember the clock — the office bills it
   * later. Entered only when it is worth billing (the app asks past two hours), but the
   * row is kept whatever the gap turns out to be: the driver's account of when they
   * arrived and left is the record, and trimming it to a threshold would quietly discard
   * the evidence for the one load somebody disputes.
   *
   * One row per driver per load per leg. `leg` is PICKUP or DELIVERY — detention happens
   * at either end, and a multi-stop load's middle stops are not yet addressable here.
   */
  DriverLoadTime: a
    .model({
      loadId:    a.string().required(),
      driverId:  a.string().required(),
      leg:       a.string().required(),  // 'PICKUP' | 'DELIVERY' — the stop's type
      // The stop the flag belongs to (Stop.id inside Load.stops). One row per stop.
      stopId:    a.string(),
      // The driver flagged detention at this stop: two hours or more past the appointment.
      // The in/out times live on the BOL, where the customer signs for them.
      detention: a.boolean(),
      // Retired 2026-10-08: the app no longer collects the clock itself. Kept so old rows
      // still read; nothing writes them.
      timeIn:    a.string(),
      timeOut:   a.string(),
      notes:     a.string(),
      createdAt: a.string().required(),
      updatedAt: a.string(),
      updatedBy: a.string(),
    })
    .secondaryIndexes((index) => [index('driverId'), index('loadId')])
    .authorization((allow) => [allow.authenticated()]),

  DriverSubmissionDoc: a
    .model({
      submissionId:  a.string().required(),
      driverId:      a.string().required(),
      kind:          a.string().required(), // 'RATECON' | 'POD'
      s3Key:         a.string().required(),
      fileName:      a.string(),
      contentType:   a.string(),
      byteSize:      a.integer(),
      pageNumber:    a.integer(), // 1-based, for multi-page scans
      uploadedAt:    a.string().required(),
      notifiedAt:    a.string(),  // set once its Slack reply + email reply are sent
      // ── Scan enhancement ─────────────────────────────────────────────────
      // The same cleanup the PODs page applies to a texted POD: deskew, crop to the
      // page, flatten the lighting. A phone photo taken at a dock needs it just as
      // much as one sent by SMS, and this is the copy that should reach a broker.
      // The original is always kept — it is the record of what actually arrived.
      enhancedKey:      a.string(),
      // ── Legibility ───────────────────────────────────────────────────────
      // Whether the page can actually be READ, which enhancement cannot fix. A photo
      // taken in a dark cab, out of focus, or of a crumpled page comes back clean and
      // still unreadable, and nobody finds out until a broker rejects the invoice weeks
      // later. Scored on upload for every fleet — Ivan's drivers and the owner operators
      // both — so the driver is told while they are still standing at the dock.
      // 'OK' | 'LOW' | 'UNREADABLE' | 'UNKNOWN' (never scored, or not an image).
      legibility:       a.string(),
      legibilityScore:  a.integer(),  // 0-100; higher is more readable
      legibilityNotes:  a.string(),   // what was wrong, in words a driver can act on

      // 'PENDING' | 'READY' | 'ORIGINAL_ONLY' | 'FAILED'. ORIGINAL_ONLY means the file
      // was never an image we could enhance (a PDF from a scanner app, for instance),
      // which is a normal outcome and not a failure.
      scanStatus:       a.string(),
      scanError:        a.string(),
      scanVersion:      a.integer(),
    })
    .secondaryIndexes((index) => [
      index('submissionId'),
      index('driverId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  MaintenanceTask: a
    .model({
      equipmentId: a.string().required(),
      title:       a.string().required(),
      dueDate:      a.string(),                        // YYYY-MM-DD
      priority:     a.string(),                        // 'high' | 'med' | 'low'
      status:       a.string(),                        // 'upcoming' | 'complete'
      completedDate: a.string(),                       // YYYY-MM-DD — set when marked complete, cleared when reopened
      notes:        a.string(),
      autoDot:      a.boolean(),
      assignee:     a.string(),
    })
    .secondaryIndexes((index) => [index('equipmentId')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  MaintenanceInvoice: a
    .model({
      equipmentId:   a.string().required(),
      date:          a.string(),                       // YYYY-MM-DD
      vendor:        a.string(),
      description:   a.string(),
      amount:        a.integer(),                      // cents
      invoiceNumber: a.string(),
      paymentMethod: a.string(),
      paymentDate:   a.string(),
      assignee:      a.string(),
      source:        a.string(),                       // 'EMAIL' (repairs@ pipeline) | 'MANUAL'
      // Review queue: 'PENDING' (emailed, awaiting review) | 'POSTED' (on the list, counts
      // in the P&L) | 'ARCHIVED' (dismissed). Null/absent is treated as POSTED so legacy and
      // manually-added invoices are unaffected; only new emailed invoices enter the queue.
      status:        a.string(),
      reviewedBy:    a.string(),                       // who posted/archived it
      // Stable source identity: date+vendor+amount and invoice # (or source document ID
      // for unnumbered invoices), frozen at ingest. Excludes the editable equipmentId
      // so assigning a truck cannot make reviewed/archived invoices reappear.
      // See scripts/invoiceDedup.mjs.
      externalId:    a.string(),
    })
    .secondaryIndexes((index) => [index('equipmentId'), index('externalId')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Intake queue ──────────────────────────────────────────────────────────
  // Records created by the slack-intake-webhook Lambda when Slack messages arrive.
  // ── Directory: customers & locations ───────────────────────────────────────
  // The reusable address book behind the Load form. A Customer carries ITS contact;
  // a Location carries the APPOINTMENT contact used to request/book appt times.
  // Writes are routed through tmsDirectoryActions so links and archives stay valid.
  Customer: a
    .model({
      name:         a.string().required(),   // e.g. "BATORY FOODS" — matched against Load.customer
      contactName:  a.string(),
      contactEmail: a.string(),
      contactPhone: a.string(),
      notes:        a.string(),
      // Phase 1: full customer record + credit / billing / workflow controls
      mcNumber:     a.string(),
      /*
       * True only when this record's NAME was looked up from its MC somewhere that knows
       * the answer. A name and an MC sitting on the same row is not that: the name comes
       * from whatever a load was booked under and the MC from whoever typed one, and the
       * factoring queue spent a day reporting that pairing as verified. MC 20313 landed on
       * a record called AMERIFREIGHT SYSTEMS LLC; the broker is Wayfinder Logistics.
       */
      mcNameVerified: a.boolean(),
      dotNumber:    a.string(),
      /*
       * Whether this customer's loads get factored.
       *
       * Factoring is what makes an MC and origin/destination ZIPs mandatory — OTR needs
       * them on the invoice. A customer we bill direct needs none of that, and demanding
       * it at booking would block work for paperwork nobody will ever send.
       *
       * Null means "not decided". Treated as NOT factored, so a customer nobody has
       * classified never blocks a booking; the factoring queue is where a missing MC
       * becomes visible, and it is visible there either way.
       */
      factored:     a.boolean(),
      billingEmail:      a.string(),
      billingContactName: a.string(),
      billingPhone:      a.string(),
      billingAddress:    a.json(),              // { street, city, state, zip, country }
      paymentTermsDays:  a.integer(),
      creditLimitCents:  a.integer(),          // non-negative integer cents
      creditHoldFlag:    a.boolean(),
      requiredDocsForInvoice: a.string().array(), // ['POD','BOL','LUMPER_RECEIPT']
      defaultDivisionKey:  a.string(),
      defaultSalesRepId:   a.string(),           // Cognito username
      aliases:        a.string().array(),        // ratecon names that resolve here
      normalizedName: a.string(),                // dedupe key (lower, strip punctuation)
      active:         a.boolean(),
      apptWorkflow:   a.enum(['NONE', 'BATORY']), // replaces /batory/i regex
      mergedIntoId:   a.string(),                // soft-merge pointer (customer merge future)

      // ── Customer v2 (Step A) ───────────────────────────────────────────────
      status: a.enum([
        'NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'NURTURING',
        'PENDING', 'ACTIVE', 'DORMANT', 'CLOSED', 'BLOCKED',
      ]),
      statusReason: a.string(),
      statusChangedAt: a.datetime(),
      statusChangedBy: a.string(),
      replacementCustomerId: a.string(),         // successor named on BLOCKED

      // Account / lead profile
      leadSource: a.string(),
      industry: a.string(),
      serviceTier: a.string(),
      website: a.string(),

      // Credit policy (customer value ?? org default ?? null/false)
      freeCreditRequired: a.boolean(),           // null = use org default
      creditUsageWarningBps: a.integer(),        // 0..10000 basis points
      maxDaysLate: a.integer(),                  // ≥0

      // Directory JSON arrays (validated element-by-element in tmsDirectoryActions)
      contacts: a.json(),                        // CustomerContact[]
      billToParties: a.json(),                   // BillToParty[]
      requiredReferences: a.json(),              // RequiredReference[]
      chargeCodeOverrides: a.json(),             // ChargeCodeOverride[]
      defaultCharges: a.json(),                  // DefaultCharge[]

      // Pricing / quoting defaults
      pricingDefaults: a.json(),                 // PricingDefaults (mode MARGIN/MARKUP/PROFIT)
      quotingDefaults: a.json(),                 // QuotingDefaults
      invoiceFrequency: a.enum(['DAILY', 'TWICE_WEEKLY', 'WEEKLY', 'MONTHLY']),
      gpSplitBps: a.integer(),                 // 0..10000 basis points

      // Document / portal preferences
      rateConTerms: a.string(),                  // override of TmsSettings.rateConTerms
      visibilityPrefs: a.json(),                 // { milestoneEmails, sharedTrackingLink, shipperPortal }

      // Ownership
      teamKey: a.string(),
      operatedById: a.string(),                  // Cognito username
      accountOwnerIds: a.string().array(),       // [0] is primary owner
    })
    .secondaryIndexes((index) => [index('normalizedName')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  Location: a
    .model({
      name:             a.string().required(),  // facility, e.g. "BATORY'S OAKLEY CHICAGO"
      city:             a.string(),             // "CHICAGO, IL"
      customerName:     a.string(),             // legacy mirror of first linked customer
      apptContactName:  a.string(),
      apptContactEmail: a.string(),             // where appointment requests are emailed
      apptContactPhone: a.string(),
      notes:            a.string(),
      // Phase 1: full address + geocode proof + facility metadata
      street:    a.string(),
      state:     a.string(),
      zip:       a.string(),
      country:   a.string().default('US'),
      lat:       a.float(),
      lng:       a.float(),
      timezone:  a.string(),
      geohash6:  a.string(),
      placeId:   a.string(),
      geocodedAt: a.datetime(),
      geocodeExpiresAt: a.datetime(),
      facilityType: a.enum(['SHIPPER', 'RECEIVER', 'BOTH', 'YARD', 'TRUCK_STOP', 'OTHER']),
      hours:     a.string(),
      apptRule:  a.enum(['FCFS', 'APPT', 'EITHER']),
      apptLeadTimeHours: a.integer(),
      dockNotes: a.string(),
      lumperNotes: a.string(),
      detentionNotes: a.string(),
      contacts:    a.json(),          // LocationContact[]
      // What drivers say about the place — gate, dock, who to ask for — written from the
      // driver app (list_append by driver-app-api); staff edits never touch this field.
      driverNotes: a.json(),          // LocationDriverNote[]
      customerIds: a.string().array(), // linked customers (many-to-many)
      aliases:     a.string().array(),
      normalizedName:    a.string(),   // dedupe by cleaned facility name
      normalizedAddress: a.string(),   // dedupe by cleaned address
      mergedIntoId: a.string(),        // reads follow the pointer
      mergeJobId:   a.string(),         // last merge that touched this row
      active:       a.boolean(),
    })
    .secondaryIndexes((index) => [
      index('normalizedName'),
      index('normalizedAddress'),
      index('mergedIntoId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Phase 1: revenue divisions replace hard-coded profit centers. Key (not id) is the PK
  // so Load.divisionKey and Customer.defaultDivisionKey reference a stable string.
  Division: a
    .model({
      id:        a.id(),
      key:       a.string().required(), // 'BCAT_LOGISTICS' | 'IVAN_CARTAGE' | 'AMAZON_DSP'
      name:      a.string().required(),
      legalName: a.string(),
      mcNumber:  a.string(),
      dotNumber: a.string(),
      scac:      a.string(),
      remitToName:    a.string(),
      remitToAddress: a.json(), // Address
      remitToEmail:   a.string(),
      invoicePrefix:  a.string(),
      fleetGroup:     a.enum(['LOCAL', 'AMAZON', 'BOX_TRUCK']),
      active:         a.boolean().required(),
    })
    .identifier(['key'])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Singleton TMS configuration. id='default'. Admin write via tmsDirectoryActions.
  TmsSettings: a
    .model({
      marginFloorBps:        a.integer(),
      defaultPaymentTermsDays: a.integer(),
      accessorialCodes:      a.json(),          // accessorial code objects
      loadStatusRules:       a.json(),
      invoiceNumberFormat:   a.string(),
      /*
       * Drop past days off the appointment queue's working list automatically.
       *
       * Company-wide rather than per-person: the appointment queue is one shared worklist,
       * and a dispatcher whose page quietly disagrees with everyone else's about what is
       * still open is worse than either setting. Applied when the queue is split, so
       * turning it back off restores every row — nothing is written to the loads.
       */
      autoClearPastAppts:    a.boolean(),

      // ── Customer v2 org defaults (Step A) ──────────────────────────────────
      defaultCreditLimitCents: a.integer(),       // ≥0
      defaultFreeCreditRequired: a.boolean(),
      defaultCreditUsageWarningBps: a.integer(),  // 0..10000
      defaultMaxDaysLate: a.integer(),            // ≥0
      requireCustomerApproval: a.boolean(),       // non-admin creates land on PENDING
      defaultRequiredDocs: a.string().array(),    // e.g. ['POD','BOL']
      defaultRequiredReferences: a.json(),        // RequiredReference[]
      chargeCodes: a.json(),                      // ChargeCodeDef[]
      rateConTerms: a.string(),                   // default rate-con terms

      // ── Shipment / Order / Load org defaults (Step B) ──────────────────────
      shipmentPrefix: a.string(),                 // 'S' → S000001
      // Counter behind the shipment number. Incremented with an atomic ADD so two
      // dispatchers building loads at the same second cannot land on one number.
      nextShipmentNumber: a.integer(),
      cancelDeleteAdminOnly: a.boolean(),         // cancel/delete restricted to owner/ADMIN
      arUnbilledStage: a.string(),                // label for the UNBILLED AR stage
      apInReviewStage: a.string(),                // label for the IN_REVIEW AP stage
      defaultMode: a.enum([
        'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
      ]),

      // ── Carrier booking org defaults (Step C) ─────────────────────────────
      allowedCarrierStatuses:  a.string().array(),  // defaults to ['ACTIVE']
      requireCarrierApproval:  a.boolean(),         // non-admin creates land on PENDING
      requiredCarrierDocs:     a.string().array(),  // ['COI_CARGO','COI_AUTO','W9','CARRIER_AGREEMENT']
      bookingRequiredFields:   a.string().array(),  // COMMODITY | DESCRIPTION | VALUE | WEIGHT
      defaultCarrierTermsDays: a.integer(),
      // QuickPayTier[] — [{ days, feeBps }], longest wait first and never more
      // expensive than a shorter one. Validated on save, not here.
      quickPayTiers:           a.json(),
      rateConExpiryHours:      a.integer(),         // how long a signing link lives (48)
      rateConRequiredFields:   a.string().array(),  // what the carrier must type to sign
      insuranceWarnDays:       a.integer(),         // expiring-soon window (30)

      // ── Tracking & check calls org defaults (Step D) ──────────────────────
      checkCallDefaultIntervalHours: a.integer(),   // 4
      checkCallGraceMinutes:         a.integer(),   // 15 — DUE becomes OVERDUE after this
      checkCallNotifyChannel:        a.enum(['IN_APP', 'SLACK', 'BOTH']),
      checkCallSlackChannelId:       a.string(),
      trackingLinkExpiryHours:       a.integer(),   // 72, counted from the last delivery appointment
      customerLinkExpiryDays:        a.integer(),   // 14
      customerLinkShowsCarrier:      a.boolean(),   // false
      customerLinkShowsPosition:     a.boolean(),   // true
      // { mode: 'CUSTOMER_REP' | 'FIXED', name?, email?, phone? } — whose details
      // the public customer page prints as "who to call".
      trackingContact:               a.json(),
      trackingSmsTemplate:           a.string(),    // must contain {url}
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Long-running (but synchronous in pieces) location merge job. Lambdas move it through.
  DirectoryMergeJob: a
    .model({
      sourceId:       a.string().required(),
      targetId:       a.string().required(),
      status:         a.enum(['RUNNING', 'COMPLETED', 'FAILED', 'PENDING']),
      processedCount: a.integer().default(0),
      remainingCount: a.integer(),
      error:          a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // ── Shipment / Order / Load (Step B) ───────────────────────────────────────
  // Three records describe one piece of freight: the Shipment is the movement and
  // owns the single customer-facing status, the Order is the sell side (and AR),
  // and the existing Load is the buy side — one row per leg, with LoadCarrier
  // assignment rows, cached LoadFinancials, and LoadCharge line items.
  //
  // Every one of them is written by tmsShipmentActions only: the client reads, and
  // the Lambda owns the transactions that keep the five tables agreeing with each
  // other. Subscriptions are dropped (see TMS_DESIGN §12) — the board polls.

  Shipment: a
    .model({
      // `TmsSettings.shipmentPrefix` + the zero-padded counter, or 'L<aljexId>'
      // for the rows the backfill created from legacy loads.
      number:          a.string().required(),
      status: a.enum([
        'DRAFT', 'TENDER_PENDING', 'TENDER_REJECTED', 'OPEN', 'ON_HOLD',
        'BOOKED', 'PLANNED', 'DISPATCHED', 'LOADING', 'PICKED_UP', 'IN_TRANSIT',
        'RECOVERED', 'ARRIVED_AT_DELIVERY_TERMINAL', 'OUT_FOR_DELIVERY',
        'UNLOADING', 'DELIVERED', 'CANCELED',
      ]),
      // What to go back to when a hold is lifted or a cancel is undone.
      previousStatus:  a.string(),
      statusChangedAt: a.datetime(),
      statusChangedBy: a.string(),
      holdReason:      a.string(),
      cancelReason:    a.string(),
      tenderRejectReason: a.string(),
      // Soft delete: a deleted shipment keeps its row so the number is never reused.
      deletedAt:       a.datetime(),
      deletedBy:       a.string(),
      customerId:      a.string().required(),
      customerName:    a.string(),           // booked-name snapshot
      mode: a.enum([
        'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
      ]),
      parentShipmentId: a.string(),          // consolidation parent (unused in B)
      orderIds:        a.string().array(),
      loadIds:         a.string().array(),
      // Mirrors of the first pickup / last delivery across the shipment's loads.
      pickupAppt:      a.string(),
      deliveryAppt:    a.string(),
      pickupMonth:     a.string(),           // 'YYYY-MM'
      originCity:      a.string(),
      destinationCity: a.string(),
      // Lower-cased number · customer · cities · reference values, so the board can
      // answer "find me 12345" without scanning five tables.
      searchKey:       a.string(),
      source:          a.enum(['MANUAL', 'TENDER', 'DUPLICATE', 'BACKFILL']),
      // ── Tracking & check calls (Step D) ─────────────────────────────────
      // The one ACTIVE CUSTOMER_VIEW TrackingLink for this shipment. Stable
      // across re-sends; Regenerate revokes it and mints a new token.
      customerLinkId:   a.string(),
      customerLinkSentAt: a.datetime(),
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
      version:         a.integer(),
    })
    .secondaryIndexes((index) => [
      index('number'),
      index('status').sortKeys(['pickupAppt']),
      index('customerId').sortKeys(['pickupAppt']),
      index('pickupMonth').sortKeys(['pickupAppt']),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // The sell side of a shipment: what the customer ordered and what they owe.
  Order: a
    .model({
      shipmentId:      a.string().required(),
      customerId:      a.string().required(),
      customerName:    a.string(),
      customerContactId: a.string(),
      customerRepId:   a.string(),           // Cognito username
      billToId:        a.string(),           // Customer.billToParties[].id
      costCenter:      a.string(),
      mode: a.enum([
        'FTL', 'PTL', 'BULK', 'DRAYAGE', 'INTERMODAL', 'RLTL', 'LTL', 'AIR', 'OCEAN', 'RAIL',
      ]),
      rateType:        a.enum(['SPOT', 'CONTRACT']),
      references:      a.json(),             // OrderReference[]
      equipmentType:   a.string(),
      equipmentLengthFt: a.integer(),
      specialRequirements: a.json(),         // SpecialRequirements
      freight:         a.json(),             // FreightItem[]
      customerNotes:   a.string(),           // travels onto customer paperwork
      internalNotes:   a.string(),           // never leaves the office
      // Cached from LoadCharge CUSTOMER lines by RECALC_CHARGES.
      customerRateCents: a.integer(),
      revenueCents:    a.integer(),
      // Invoicing and payment are never inferred: B writes DOCS_NEEDED, UNBILLED
      // and INVOICE_NOT_NEEDED only. UNPAID/PAID belong to step F.
      arStatus:        a.enum(['DOCS_NEEDED', 'UNBILLED', 'UNPAID', 'PAID', 'INVOICE_NOT_NEEDED']),
      arStatusChangedAt: a.datetime(),
      invoiceId:       a.string(),
      invoiceEarly:    a.boolean(),          // bill before delivery
      readyToInvoiceAt: a.datetime(),
      pickupAppt:      a.string(),           // mirror, sort key of the customer index
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
      version:         a.integer(),
    })
    .secondaryIndexes((index) => [
      index('shipmentId'),
      index('customerId').sortKeys(['pickupAppt']),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Who is pulling one leg. A bounce or a TONU does not erase the row: it is marked
  // and a new ACTIVE row is written, so the history of who dropped a load survives.
  LoadCarrier: a
    .model({
      loadId:          a.string().required(),
      shipmentId:      a.string().required(),
      kind:            a.enum(['OWN_ASSET', 'CARRIER']),
      status:          a.enum(['ACTIVE', 'BOUNCED', 'TONU']),
      removalReason:   a.string(),
      // Whatever the dispatcher typed alongside the reason code (<=250 chars).
      removalNote:     a.string(),
      removedAt:       a.datetime(),
      removedBy:       a.string(),
      sequence:        a.integer(),          // 1-based assignment attempt
      carrierId:       a.string(),           // directory Carrier (step C)
      carrierName:     a.string(),
      carrierMc:       a.string(),
      carrierRepId:    a.string(),
      dispatcherName:  a.string(),
      dispatcherPhone: a.string(),
      dispatcherEmail: a.string(),
      driverId:        a.string(),           // own-fleet Driver.id
      driverName:      a.string(),
      driverPhone:     a.string(),
      driver2Name:     a.string(),
      driver2Phone:    a.string(),
      truckId:         a.string(),
      truckNumber:     a.string(),
      trailerId:       a.string(),
      trailerNumber:   a.string(),
      plates:          a.string(),
      vin:             a.string(),
      sealNumber:      a.string(),
      tripNumber:      a.string(),
      pickupEtaAt:     a.datetime(),
      deliveryEtaAt:   a.datetime(),
      priorDeliveryAt: a.datetime(),
      priorDeliveryNote: a.string(),
      rateConSignedAt: a.datetime(),
      rateConKey:      a.string(),           // S3 key of the signed rate confirmation
      chargesFinalizedAt: a.datetime(),
      // Cached from LoadCharge CARRIER lines by RECALC_CHARGES.
      carrierRateCents: a.integer(),
      costCents:       a.integer(),
      // B writes AWAITING_INVOICE only; the rest is step G.
      apStatus:        a.enum(['AWAITING_INVOICE', 'IN_REVIEW', 'TO_BE_PAID', 'PAID']),
      invoiceId:       a.string(),

      // ── Carriers & booking (Step C) ──────────────────────────────────────
      // Quick pay: what we keep for paying early. Cached as both the bps the
      // tier charged and the cents it works out to, so AP, the rate con and
      // the booking screen can never disagree about the number.
      quickPay:          a.boolean(),
      quickPayDays:      a.integer(),
      quickPayFeeBps:    a.integer(),
      quickPayFeeCents:  a.integer(),
      paymentTermsDays:  a.integer(),
      // The rate confirmation the carrier signs. `rateConToken` is the one-time
      // secret in the emailed link, cleared the moment it is used or voided;
      // the public sign API finds the row by scanning for it. There is
      // deliberately no index on it — DynamoDB allows one new GSI per table
      // update, and carrierId below is the one the directory cannot do without.
      rateConStatus: a.enum([
        'NOT_SENT', 'SENT', 'OPENED', 'SIGNED', 'DECLINED', 'VOIDED', 'EXPIRED',
      ]),
      rateConToken:      a.string(),
      rateConSentAt:     a.datetime(),
      rateConSentTo:     a.string(),          // comma-joined recipients
      rateConExpiresAt:  a.datetime(),
      rateConDocumentId: a.string(),          // CarrierDocument holding the PDF
      rateConSignerName: a.string(),
      rateConSignerIp:   a.string(),
      rateConVersion:    a.integer(),         // bumped on every re-send
      bookedAt:          a.datetime(),
      // The eligibility findings whoever booked this carrier acknowledged, kept
      // as the record of what was waived — and appended to when a carrier's
      // status changes underneath a load that is already covered.
      bookingWarnings:   a.string().array(),
      dispatchedAt:      a.datetime(),
      dispatchNote:      a.string(),
      // ── Tracking & check calls (Step D) ─────────────────────────────────
      // The ACTIVE CARRIER_PING TrackingLink texted to this carrier's driver.
      trackingLinkId:    a.string(),
      trackingStartedAt: a.datetime(),
      trackingStoppedAt: a.datetime(),
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
    })
    .secondaryIndexes((index) => [index('loadId'), index('shipmentId'), index('carrierId')])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Cached totals for one load. `id` IS the load id, so a bundle read is a GetItem
  // and the row can never drift onto a second record for the same load.
  LoadFinancials: a
    .model({
      // The row's `id` IS the load id — set explicitly on write, never generated.
      loadId:          a.string().required(),
      shipmentId:      a.string().required(),
      orderId:         a.string(),
      customerRateCents: a.integer().required(),
      revenueCents:    a.integer().required(),
      carrierRateCents: a.integer().required(),
      costCents:       a.integer().required(),
      profitCents:     a.integer().required(),
      marginBps:       a.integer().required(),
      topSpendCents:   a.integer(),
      targetBuyCents:  a.integer(),
      // Set once the money is committed (step F). RECALC_CHARGES refuses after this.
      frozenAt:        a.datetime(),
      frozenBy:        a.string(),
      updatedBy:       a.string().required(),
      version:         a.integer().required(),
    })
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // One financial line item — MVMNT's FinancialLineItem. CUSTOMER lines sum into the
  // order's revenue, CARRIER lines into the assignment's cost.
  LoadCharge: a
    .model({
      shipmentId:      a.string().required(),
      side:            a.enum(['CUSTOMER', 'CARRIER']),
      orderId:         a.string(),           // CUSTOMER lines
      loadId:          a.string(),
      loadCarrierId:   a.string(),           // CARRIER lines
      code:            a.string().required(),
      label:           a.string(),
      calculatedBy:    a.enum(['FLAT', 'PER_MILE', 'PER_CWT', 'PERCENT']),
      rateCents:       a.integer().required(),
      count:           a.integer().default(1),
      amountCents:     a.integer().required(),
      // LINEHAUL and FSC are the rate: they are what "Customer Rate" and "Carrier
      // Rate" mean, and they are the base a PERCENT line is taken from.
      isRate:          a.boolean().required(),
      release:         a.string(),
      sortOrder:       a.integer().required(),
      note:            a.string(),
      createdBy:       a.string().required(),
    })
    .secondaryIndexes((index) => [index('shipmentId').sortKeys(['sortOrder'])])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // ── Tracking & check calls (Step D) ────────────────────────────────────────
  // One row per thing that happened to a load in transit: a check call somebody
  // logged, a stop the driver app stamped, a ping off the carrier's SMS link, the
  // dispatch itself, an ETA change, an incident. The Tracking tab is this table
  // read newest-first; Motive fixes are NOT copied in here (six an hour per truck
  // would swamp it) — they are merged in memory from TruckLocationHistory.
  //
  // Written by tmsShipmentActions, tmsTrackingActions, load-tracking-projector and
  // the public tracking-api; the client only reads.
  LoadCheckCall: a
    .model({
      loadId:        a.string().required(),
      shipmentId:    a.string().required(),
      loadCarrierId: a.string(),
      stopId:        a.string(),
      // When it happened. `createdAt` is when somebody typed it in.
      at:            a.datetime().required(),
      type: a.enum([
        'DISPATCH', 'LOCATION_UPDATE', 'ARRIVED', 'DEPARTED', 'ETA_UPDATE',
        'INCIDENT', 'NOTE', 'TRACKING_LINK_SENT', 'TRACKING_PING',
      ]),
      source:        a.enum(['MANUAL', 'DRIVER_APP', 'LINK', 'SYSTEM']),
      incidentType: a.enum([
        'ACCIDENT', 'ACTUAL_CLAIM', 'ATTEMPTED_DELIVERY', 'BREAKDOWN', 'DELAY',
        'DELIVERY_NOT_COMPLETED', 'DETENTION', 'FRAUD', 'GENERAL_EXCEPTION', 'LAYOVER',
        'LOAD_LOCK_ALERT', 'OVERAGE_SHORTAGE', 'PICKUP_EXCEPTION', 'POTENTIAL_CLAIM',
        'REFUSED_BY_CONSIGNEE', 'REJECTION', 'SHIPMENT_CANCELLED', 'SHIPMENT_DAMAGED',
        'SHIPMENT_DELAYED', 'SHIPMENT_RECONSIGNED', 'SHIPMENT_RETURNED_TO_SHIPPER',
        'STORAGE_IN_TRANSIT', 'TONU',
      ]),
      // Sparse marker: the literal 'OPEN' only while an incident is unresolved,
      // so the incidentOpen index holds the exceptions queue and nothing else.
      incidentOpen:   a.string(),
      resolvedAt:     a.datetime(),
      resolvedBy:     a.string(),
      resolutionNote: a.string(),
      // Null when the event moved nothing.
      statusBefore:   a.string(),
      statusAfter:    a.string(),
      city:           a.string(),
      state:          a.string(),
      lat:            a.float(),
      lng:            a.float(),
      accuracyM:      a.integer(),
      personName:     a.string(),
      note:           a.string(),
      // The DispatchMessage id when the note was texted to the driver.
      driverMessageId: a.string(),
      // Snapshot of the charge lines this event created: { side, code, amountCents, chargeId }[]
      charges:        a.json(),
      // What this call scheduled next, kept so the timeline reads back honestly.
      nextCheckCallAt:   a.datetime(),
      nextCheckCallNote: a.string(),
      pickupEtaAt:    a.datetime(),
      deliveryEtaAt:  a.datetime(),
      // staff e-mail · `driver:<id>` · `link:<token8>` · `system`
      createdBy:      a.string().required(),
    })
    .secondaryIndexes((index) => [
      index('loadId').sortKeys(['at']),
      index('shipmentId').sortKeys(['at']),
      index('incidentOpen').sortKeys(['at']),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // A tokenised public link. The row's `id` IS the token (24 random bytes,
  // base64url) — the public Lambda does a GetItem on it, so there is no token
  // index anywhere and a guess has to hit a 192-bit primary key.
  TrackingLink: a
    .model({
      kind:          a.enum(['CARRIER_PING', 'CUSTOMER_VIEW']),
      shipmentId:    a.string().required(),
      loadId:        a.string(),
      loadCarrierId: a.string(),
      status:        a.enum(['ACTIVE', 'REVOKED', 'EXPIRED']),
      expiresAt:     a.datetime().required(),
      sentTo:        a.string(),            // E.164, or comma-joined e-mails
      sentVia:       a.enum(['SMS', 'EMAIL', 'COPY']),
      sentAt:        a.datetime(),
      smsMessageId:  a.string(),
      // Snapshot of who the customer page says to call, taken when the link was minted.
      contactName:   a.string(),
      contactEmail:  a.string(),
      contactPhone:  a.string(),
      showCarrier:   a.boolean(),
      showPosition:  a.boolean(),
      openCount:     a.integer(),
      lastOpenedAt:  a.datetime(),
      // Rate limits, bumped with an atomic ADD by the public Lambda.
      requestCount:  a.integer(),
      pingCount:     a.integer(),
      lastPingAt:        a.datetime(),
      lastPingLat:       a.float(),
      lastPingLng:       a.float(),
      lastPingAccuracyM: a.integer(),
      revokedAt:     a.datetime(),
      revokedBy:     a.string(),
      createdBy:     a.string().required(),
    })
    .secondaryIndexes((index) => [index('shipmentId'), index('loadId')])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // ── Carriers (Step C) ──────────────────────────────────────────────────────
  // Outside carriers only: a row here is somebody we pay by the load. The own
  // fleet stays Driver + Equipment and books through the existing ASSIGN_ASSET
  // picker, so nothing on the calendar, settlements or the driver app changes.
  //
  // All four carrier models are written by tmsCarrierActions alone — the client
  // reads. Subscriptions are dropped (see TMS_DESIGN §12); the directory polls.
  //
  // `type`, `status` and the rest of the enums below cannot carry .required():
  // Amplify Gen 2 enum fields take no modifiers. The Lambda demands them.
  Carrier: a
    .model({
      name:           a.string().required(),
      dbaName:        a.string(),
      normalizedName: a.string(),            // dedupe key (lower, strip punctuation)
      type: a.enum(['TL', 'LTL', 'CARTAGE', 'LINEHAUL', 'AIR', 'OCEAN', 'RAIL', 'AGENT']),
      status: a.enum(['PENDING', 'REVIEW', 'ACTIVE', 'INACTIVE', 'DO_NOT_USE']),
      // One list, both halves: the first five reasons belong to INACTIVE, the
      // last five to DO_NOT_USE. Which ones a status may use is a lib decision
      // (src/lib/carrierStatus.ts), not a schema one.
      statusReason: a.enum([
        'EXPIRED_INSURANCE', 'INACTIVE_AUTHORITY', 'INACTIVE_AGREEMENT', 'SAFETY_ISSUES', 'OTHER',
        'DOUBLE_BROKERING', 'CARGO_CLAIM', 'THEFT', 'FRAUD', 'SUSPICIOUS_ACTIVITY',
      ]),
      statusNote:      a.string(),
      statusChangedAt: a.datetime(),
      statusChangedBy: a.string(),

      // Authority and identity
      mcNumber:   a.string(),
      dotNumber:  a.string(),
      scac:       a.string(),
      einNumber:  a.string(),
      inFmcsa:    a.boolean(),
      authorityStatus: a.enum(['ACTIVE', 'INACTIVE', 'NONE', 'UNKNOWN']),
      authorityGrantedAt: a.datetime(),
      authorityExpiresAt: a.datetime(),

      // Safety profile, typed in from SAFER until J brings an integration.
      safetyRating: a.enum(['SATISFACTORY', 'CONDITIONAL', 'UNSATISFACTORY', 'NONE', 'UNKNOWN']),
      safetyRatingAt:     a.datetime(),
      reviewType:         a.string(),
      reviewedAt:         a.datetime(),
      driverInspections:  a.integer(),
      driverOos:          a.integer(),
      vehicleInspections: a.integer(),
      vehicleOos:         a.integer(),

      // InsurancePolicy[] — validated element-by-element in tmsCarrierActions,
      // capped at 50. Expiry against the pickup date is what blocks a booking.
      insurancePolicies: a.json(),
      equipment:    a.string().array(),      // CONTAINER | FLATBED | POWER_ONLY | REEFER | SPECIALIZED | TANKER | VAN
      cargoTypes:   a.string().array(),
      powerUnits:   a.integer(),
      trailerCount: a.integer(),
      driverCount:  a.integer(),

      address:  a.json(),                    // { street, city, state, zip, country }
      phone:    a.string(),
      email:    a.string(),
      website:  a.string(),
      // Mirror of the primary DISPATCH contact, so booking a load does not have
      // to read the contact table to fill in who answers the phone.
      dispatcherName:  a.string(),
      dispatcherPhone: a.string(),
      dispatcherEmail: a.string(),

      paymentTermsDays:      a.integer(),
      quickPayEligible:      a.boolean(),
      defaultQuickPayDays:   a.integer(),
      factorPaymentMethodId: a.string(),     // CarrierPaymentMethod the factor is paid through

      // Manual compliance status until the Highway / RMIS / MyCarrierPackets
      // integrations land in J. MCP is free text — their statuses are theirs.
      highwayStatus: a.enum(['PASS', 'FAIL', 'INCOMPLETE', 'PARTIAL', 'NONE']),
      rmisStatus:    a.enum(['PASS', 'FAIL', 'INCOMPLETE', 'PARTIAL', 'NONE']),
      mcpStatus:     a.string(),

      accountOwnerIds: a.string().array(),   // [0] is primary owner
      teamKey:         a.string(),
      internalNotes:   a.string(),
      loadCount:       a.integer(),          // cached by BOOK_CARRIER
      lastLoadAt:      a.datetime(),
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
      version:         a.integer(),
    })
    .secondaryIndexes((index) => [
      index('normalizedName'),
      index('status').sortKeys(['name']),
      index('mcNumber'),
      index('dotNumber'),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Who to call at a carrier. One row may wear several hats (`types`), and at
  // most one row per carrier is `isPrimary` — enforced in the Lambda, which
  // demotes the previous primary in the same write.
  CarrierContact: a
    .model({
      carrierId: a.string().required(),
      name:      a.string().required(),
      types:     a.string().array(),         // ACCOUNTING | AFTER_HOURS | CLAIMS | DISPATCH | DRIVER | EMERGENCY | MANAGER | OWNER
      email:     a.string(),
      phone:     a.string(),
      isPrimary: a.boolean(),
      rateConRecipient: a.boolean(),         // defaulted into the rate-con To: line
      active:    a.boolean(),
      createdBy: a.string().required(),
      updatedBy: a.string().required(),
    })
    .secondaryIndexes((index) => [index('carrierId')])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Where the money goes. Full account and routing numbers are never stored on
  // the item — only the last four and a `bankDetailsKey` pointing at the
  // document in S3 — so a read of this table can never leak a bank account.
  CarrierPaymentMethod: a
    .model({
      carrierId:     a.string().required(),
      method:        a.enum(['ACH', 'WIRE', 'CHECK', 'ZELLE', 'VENMO', 'EFT']),
      // A factored carrier is paid through its factor, not through itself.
      recipientType: a.enum(['CARRIER', 'FACTOR']),
      factorName:    a.string(),
      factorAddress: a.json(),               // Address
      bankName:      a.string(),
      accountName:   a.string(),
      accountLast4:  a.string(),
      routingLast4:  a.string(),
      bankDetailsKey: a.string(),            // carrier-docs/{carrierId}/private/…
      payeeEmail:    a.string(),
      remitToAddress: a.json(),              // Address
      isPreferred:   a.boolean(),            // at most one per carrier
      status:        a.enum(['ACTIVE', 'INACTIVE']),
      createdBy:     a.string().required(),
      updatedBy:     a.string().required(),
    })
    .secondaryIndexes((index) => [index('carrierId')])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // A carrier's paperwork: the packet they send us (authority, COIs, W9, the
  // signed agreement) plus every rate confirmation we generate for them. The
  // bytes live under carrier-docs/{carrierId}/; this row is the index of them.
  CarrierDocument: a
    .model({
      carrierId: a.string().required(),
      type: a.enum([
        'AUTHORITY', 'COI_AUTO', 'COI_CARGO', 'COI_GENERAL', 'W9', 'CARRIER_AGREEMENT',
        'FACTOR_NOA', 'CDL', 'RATE_CON', 'OTHER',
      ]),
      name:        a.string().required(),
      s3Key:       a.string().required(),
      contentType: a.string().required(),
      sizeBytes:   a.integer().required(),
      expiresAt:   a.datetime(),             // COIs expire; a missing date is "never checked"
      loadCarrierId: a.string(),             // RATE_CON rows only
      // UPLOAD is a file somebody sent us, GENERATED is a rate con we built,
      // SIGNED is the copy that came back with a signature on it.
      source:      a.enum(['UPLOAD', 'GENERATED', 'SIGNED']),
      uploadedBy:  a.string().required(),
    })
    .secondaryIndexes((index) => [index('carrierId').sortKeys(['type'])])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  IntakeItem: a
    .model({
      source:               a.enum(['IVAN_CARTAGE', 'BCAT_LOGISTICS']),
      status:               a.enum(['NEW', 'IN_PROGRESS', 'BUILT', 'DONE', 'ARCHIVED']),
      assignedTo:           a.string(),        // email of the team member responsible
      receivedAt:           a.datetime(),
      fromEmail:            a.string(),        // Slack user ID or legacy email
      subject:              a.string(),        // first line of message or legacy subject
      bodyText:             a.string(),
      bodyHtml:             a.string(),
      s3KeyPdfAttachments:  a.string().array(),
      externalSource:       a.enum(['gmail', 'slack', 'manual']),   // platform origin
      externalId:           a.string(),        // dedup key: "channelId:ts" or legacy gmailMessageId
      externalUrl:          a.string(),        // Slack permalink or Gmail link
      slackChannelId:       a.string(),        // Slack channel ID (slack only)
      slackMessageTs:       a.string(),        // Slack message timestamp (slack only)
      gmailMessageId:       a.string(),        // legacy — kept for backward compat
      extractedMetadata:    a.json(),
      builtLoadId:          a.id(),
      proNumber:            a.string(),   // BCAT Logistics: Pro# entered on Mark as Done
      notes:                a.string(),
      /*
       * When the reconciler replied in this item's Slack thread, ISO.
       *
       * The idempotency key for automatic replies. Set the moment chat.postMessage
       * succeeds, checked before every send — a cron that ran twice, or retried after a
       * timeout, must not post "PRO# 14589 - Added in BCAT Ops" into the same thread again.
       */
      slackRepliedAt:       a.string(),
      /*
       * A cached summary of the item's Slack thread, refreshed by intake-reconcile.
       *
       * The queue's whole problem is that the conversation happens in Slack and the app
       * never sees it. Fetching 1,000+ threads when the page opens would exceed Slack's
       * rate limit many times over, so the job that already holds the token and already
       * walks these items stores the last thing said in each one.
       */
      lastReplyText:        a.string(),
      lastReplyAt:          a.string(),   // Slack ts of that reply
      lastReplyUser:        a.string(),   // Slack user id
      replyCount:           a.integer(),
      threadSyncedAt:       a.string(),
    })
    .secondaryIndexes((index) => [
      index('assignedTo').sortKeys(['receivedAt']),
      index('source').sortKeys(['receivedAt']),
      index('externalId'),
      index('gmailMessageId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Factoring queue (Operations page) ──────────────────────────────────────
  // Emails sent to ivanfactoring@bcatcorp.com become rows here. The id is the literal
  // PRO number string so duplicate PROs safely collide instead of creating
  // multiple rows. Status is advanced by the finance team in the UI; the intake
  // Lambda never overwrites an existing row.
  FactoringItem: a
    .model({
      proNumber:  a.string().required(),
      /*
       * ARCHIVED takes a row out of the working queue without destroying it. Added when the
       * queue was reset to a clean slate: the history is worth keeping, and a status is
       * reversible in a way a delete is not.
       */
      // MANUAL_INVOICE: OTR said No Buy (or a person chose direct billing); the invoice goes
      // out by hand through the steps in src/lib/manualInvoice.ts. INVOICED_MANUALLY: done.
      status:     a.enum(['NEED_TO_FACTOR', 'PENDING_WITH_OTR', 'FACTORED', 'ARCHIVED', 'MANUAL_INVOICE', 'INVOICED_MANUALLY']),
      subject:    a.string().required(),
      fromEmail:  a.string().required(),
      /** Who the invoice email was delivered to. The queue only accepts the factoring group. */
      toEmails:   a.string().array(),
      receivedAt: a.datetime().required(),
      messageId:  a.string().required(),

      // ── OTR Solutions factoring (see src/lib/otrInvoice.ts) ──────────────
      // The Load this PRO belongs to. Resolved on intake by matching proNumber
      // against Load.aljexId (trimmed — the live table stores trailing spaces).
      loadId:          a.string(),
      // Values a human typed on the queue row; highest precedence when the
      // payload is assembled. Shape: Partial<Record<OtrRequiredField, string>>.
      otrManualFields: a.json(),
      // Last assembled readiness, cached so the queue renders without
      // re-deriving: { ready, payload, sources, missingFields, missingDocuments }.
      otrReadiness:    a.json(),
      // The broker this row bills, set when an MC is entered on the row. Lets a row
      // whose load was never built still name its customer and carry the MC.
      customerId:      a.string(),
      // Broker approval from OTR's /broker-check, checked BEFORE submit so an
      // unapproved MC shows on the row instead of failing with a 402.
      brokerMcChecked:   a.string(),
      /*
       * NOT_FOUND is distinct from NOT_APPROVED on purpose. "Not approved" is OTR declining
       * a broker they know; "not found" is OTR having no such MC at all — which is the case
       * that makes a create return 204 and silently do nothing, so it blocks the submit.
       */
      // NO_BUY: OTR knows the broker and will not factor its paper. Flagged, and the row
      // moves to MANUAL_INVOICE on its own.
      brokerCheckResult: a.enum(['APPROVED', 'CALL_OFFICE', 'NOT_APPROVED', 'NOT_FOUND', 'UNKNOWN', 'NO_BUY']),
      brokerCheckedAt:   a.datetime(),
      // Set once the invoice exists at OTR. otrInvoiceId is their identifier and
      // is required by every document upload and status read.
      otrInvoiceId:    a.string(),
      otrSubmittedAt:  a.datetime(),
      otrSubmittedBy:  a.string(),
      // Mirrored from GET /invoices/{id} so the queue shows OTR's own board:
      // Pending, Advance Pending, Advance Paid, Approved, Client Request,
      // Duplicate, OTR Follow-Up, Paid.
      otrStatus:       a.string(),
      otrScheduleId:   a.string(),
      otrAmount:       a.integer(), // cents, as submitted
      otrStatusSyncedAt: a.datetime(),
      // ── Invoicing by hand ─────────────────────────────────────────────────
      manualReason:     a.string(),    // 'NO_BUY' | 'MANUAL'
      manualSteps:      a.json(),      // ManualInvoiceSteps — see src/lib/manualInvoice.ts
      apEmail:          a.string(),    // the broker's AP address the invoice goes to
      manualInvoicedAt: a.datetime(),
      // Which documents reached OTR, so a partial upload is visible.
      otrDocsUploaded: a.json(), // { pod?: string, rateConfirmation?: string }
      // Last failure from OTR, surfaced on the row rather than only in logs.
      otrError:        a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [
      allow.authenticated().to(['create', 'read', 'update']),
      allow.groups(['ADMIN']).to(['delete']),
    ]),

  // Writes go through the action Lambda so payment details and linked maintenance
  // invoices are validated and committed together. Direct deletes are admin-only.
  VendorPayable: a
    .model({
      status: a.enum(['NEED_TO_PAY', 'DONE']),
      source: a.enum(['MAINTENANCE', 'EMAIL']),
      sourceInvoiceId: a.string(),
      sourceMessageId: a.string(),
      subject: a.string().required(),
      vendor: a.string(),
      invoiceNumber: a.string(),
      amount: a.integer(), // cents; absent until an email invoice is reviewed
      invoiceDate: a.date(),
      dueDate: a.date(),                 // from the invoice, read by the extractor or typed
      vendorEmail: a.string(),           // where the payment confirmation goes; defaults to the sender
      confirmationSentAt: a.datetime(),  // when the payment confirmation email went out
      confirmationSentTo: a.string(),
      extractedAt: a.datetime(),         // when the extractor last read the attachments
      extractionNote: a.string(),        // what it found or why it could not
      description: a.string(),
      fromEmail: a.string(),
      emailBody: a.string(),
      attachments: a.json(),
      receivedAt: a.datetime().required(),
      paymentMethod: a.string(),
      paymentDate: a.date(),
      paymentReference: a.string(),
      paidBy: a.string(),
      paidAt: a.datetime(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [
      allow.authenticated().to(['read']),
      allow.groups(['ADMIN']).to(['delete']),
    ]),

  manageVendorPayable: a
    .mutation()
    .arguments({
      action: a.string().required(),
      id: a.id(),
      maintenanceInvoiceId: a.id(),
      input: a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(vendorApActions)),

  // ── JobsDone POD documents ─────────────────────────────────────────────────
  // All access is routed through the managePods custom action below. Clients never
  // write directly; original image keys and source URLs stay backend-only.
  PodDocument: a
    .model({
      clientId:          a.string().required(),
      sourceMessageId:   a.string().required(),
      mediaIndex:        a.integer().required(),
      companyName:       a.string().required(),
      senderName:        a.string().required(),
      senderContact:     a.string().required(),
      receivedAt:        a.string().required(),   // ISO8601 from JobsDone createdAt
      referenceNumber:   a.string().required(),
      notes:             a.string().required(),
      isAllowed:         a.boolean().required(),
      fileName:          a.string().required(),
      contentType:       a.string(),
      originalKey:       a.string(),
      enhancedKey:       a.string(),
      processingStatus:  a.string().required(),   // PENDING | READY | ORIGINAL_ONLY | FAILED
      processingError:   a.string(),
      processingVersion: a.integer(),             // scanner version that produced enhancedKey
      scanReviewReason:  a.string(),               // JSON array of review flags or summary
      sourceUrl:         a.string().required(),   // backend-only; omitted from responses
      loadId:            a.string(),
      assignedBy:        a.string(),
      assignedAt:        a.string(),
      version:           a.integer().required().default(1),
      createdAt:         a.datetime().required(),
      updatedAt:         a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('clientId').sortKeys(['receivedAt']),
      index('loadId').sortKeys(['receivedAt']),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [
      // No direct client operations; all access is routed through managePods.
      allow.authenticated().to([]),
    ]),

  // User-managed mapping from JobsDone sender identifiers to local Driver.id.
  // Key by normalized phone (phone:<10 digits>) or name (name:<normalized tokens>).
  // No direct client operations; all access is routed through managePods.
  PodSenderMapping: a
    .model({
      clientId:   a.string().required(),   // JobsDone tenant/client id
      senderKey:  a.string().required(),   // phone:<digits> or name:<lowercased-tokens>
      senderName: a.string().required(),   // display name from JobsDone
      driverId:   a.string().required(),   // local Driver.id
      updatedBy:  a.string().required(),
      updatedAt:  a.datetime().required(),
    })
    .identifier(['clientId', 'senderKey'])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [
      allow.authenticated().to([]),
    ]),

  AuditLog: a
    .model({
      entityType: a.string().required(),
      entityId:   a.string().required(),
      action:     a.string().required(),
      user:       a.string().required(),
      changes:    a.json().required(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [
      allow.authenticated().to(['create', 'read']),
    ]),

  // ── Fuel transactions ──────────────────────────────────────────────────────
  // Imported from EFS Transaction Reports. One record per line item.
  // Covers fuel (ULSD/DEFD), scale fees (SCLE), cash advances (CASH), and others.
  FuelTransaction: a
    .model({
      transactionDate: a.date().required(),
      cardNumber:      a.string().required(),   // as it appears in the EFS report (e.g. "00007")
      invoiceNumber:   a.string(),
      unitNumber:      a.string(),              // raw from report Unit column
      truckId:         a.string(),              // Equipment.id resolved via cardNumber lookup
      driverName:      a.string(),
      odometer:        a.integer(),
      locationName:    a.string(),
      city:            a.string(),
      state:           a.string(),
      fees:            a.float(),               // dollars; 0 if none
      fuelType:        a.string().required(),   // raw item type: ULSD, DEFD, SCLE, CASH, etc.
      itemCategory:    a.enum(['FUEL', 'SCALE', 'CASH_ADVANCE', 'OTHER']), // derived category
      pricePerUnit:    a.float().required(),
      quantity:        a.float().required(),
      amount:          a.float().required(),
      currency:        a.string(),
      sourceFile:      a.string(),
      importedAt:      a.datetime(),
    })
    .secondaryIndexes((index) => [
      index('truckId').sortKeys(['transactionDate']),
      index('cardNumber').sortKeys(['transactionDate']),
      index('transactionDate'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Per-truck expense tracking ─────────────────────────────────────────────

  // Catalog of cost categories (insurance, fuel, financing, etc.)
  ExpenseType: a
    .model({
      name:               a.string().required(),
      // FUEL is tracked via FuelTransaction; this entry enables fuel in the
      // aggregation engine without duplicating data into ExpenseRecord.
      category:           a.enum(['FUEL', 'INSURANCE', 'FINANCING', 'LEASE', 'MAINTENANCE', 'PERMITS', 'TOLLS', 'OTHER']),
      defaultEntryMethod: a.enum(['FIXED', 'MANUAL', 'AUTO_INGESTED']),
      active:             a.boolean().required(),
      notes:              a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Defines which trucks share a cost and how it splits
  TruckExpenseAllocation: a
    .model({
      expenseTypeId:    a.string().required(),
      // DIRECT: one truck per record (directTruckId on ExpenseRecord)
      // SPLIT_EVEN: amount ÷ truckIds.length, shared across truckIds
      allocationMethod: a.enum(['DIRECT', 'SPLIT_EVEN']),
      truckIds:         a.string().array(),  // trucks in this allocation
      notes:            a.string(),
      // Reserved for future SPLIT_WEIGHTED (per-truck percent/shares):
      // shares: a.json(),
    })
    .secondaryIndexes((index) => [
      index('expenseTypeId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Actual cost record for a time period
  // Store the TOTAL amount once; per-truck share is computed on read.
  ExpenseRecord: a
    .model({
      expenseTypeId:   a.string().required(),
      allocationId:    a.string(),           // → TruckExpenseAllocation (SPLIT_EVEN)
      amount:          a.float().required(),  // total cost before any split
      periodMonth:     a.string(),           // "2026-05" — for recurring/monthly costs
      transactionDate: a.date(),             // specific date — for one-off costs
      entryMethod:     a.enum(['FIXED', 'MANUAL', 'AUTO_INGESTED']),
      directTruckId:   a.string(),           // set for DIRECT allocation only
      notes:           a.string(),
      source:          a.string(),           // "recurring-generator", "manual-entry", etc.
    })
    .secondaryIndexes((index) => [
      index('expenseTypeId').sortKeys(['periodMonth']),
      index('periodMonth'),
      index('directTruckId').sortKeys(['transactionDate']),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Template for FIXED costs that repeat monthly.
  // The generate-recurring-expenses Lambda creates one ExpenseRecord per
  // active RecurringExpense per calendar month.
  RecurringExpense: a
    .model({
      expenseTypeId: a.string().required(),
      allocationId:  a.string().required(),
      monthlyAmount: a.float().required(),
      startMonth:    a.string().required(),  // "2026-05"
      endMonth:      a.string(),             // null = ongoing
      // The day the amount took effect / stopped. Set by every change made on the Finances or
      // Expenses page; the boundary months are prorated by day. Null = the whole month.
      startDate:     a.date(),
      endDate:       a.date(),
      active:        a.boolean().required(),
      notes:         a.string(),
    })
    .secondaryIndexes((index) => [
      index('expenseTypeId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Truck ownership + Motive vehicle mapping ──────────────────────────────
  // One record per truck (truckId = Equipment.id as primary key).
  // ownershipType drives which trucks appear in efficiency metrics and get synced.
  // motiveVehicleId is discovered on first sync by matching unitNumber → Motive number.
  TruckConfig: a
    .model({
      truckId:             a.string().required(),   // Equipment.id — used as PK
      unitNumber:          a.string().required(),   // e.g. "009"
      // ownershipType is load-bearing for Motive sync (filters 'COMPANY'). The DOT-compliance
      // spec's "COMPANY_OWNED" maps onto the existing 'COMPANY' value; only 'LEASED' is added so
      // existing records and the motive-mileage-sync filter keep working unchanged.
      ownershipType:       a.enum(['COMPANY', 'OWNER_OPERATOR', 'LEASED']),
      motiveVehicleId:     a.integer(),             // Motive integer vehicle ID
      motiveVehicleNumber: a.string(),              // Motive 'number' field (should = unitNumber)
      // ── DOT onboarding / compliance (internal only — trucks have no portal) ──
      onboardingStatus:       a.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE']),
      complianceStatus:       a.enum(['COMPLIANT', 'EXPIRING_SOON', 'NON_COMPLIANT', 'UNKNOWN']), // cached, updated by scanner
      assignedFuelCardNumber: a.string(),   // LAST 4 DIGITS ONLY — never store full card numbers
      assignedPhone:          a.string(),
      assignedTablet:         a.string(),
      eldSerialNumber:        a.string(),
      inServiceDate:          a.date(),
    })
    .identifier(['truckId'])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Company phones handed to Ivan's local drivers ─────────────────────────
  // One row per device ("Ivan Cartage #1", "Ivan Cartage Ipad"), keyed by that name so a
  // device can never be entered twice. The number belongs to the device, not the driver:
  // when a phone changes hands its number goes with it. The driver's own number stays on
  // Driver.phone.
  CompanyPhone: a
    .model({
      label:            a.string().required(),
      number:           a.string(),
      assignedDriverId: a.string(),   // Driver.id; null = in the office
      sortOrder:        a.integer(),
    })
    .identifier(['label'])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Per-truck odometer day from Motive ELD ────────────────────────────────
  // One row per truck per calendar day. The Sunday 00:00 reading opens the week
  // and every later day closes against the one before it, so a week's miles are
  // the sum of its day rows and never double-count a reading. Idempotent:
  // re-syncing a day overwrites it. Lambda writes via DynamoDB SDK; the fleet
  // pages read via AppSync.
  TruckOdometerDay: a
    .model({
      truckId:        a.string().required(),  // Equipment.id
      date:           a.string().required(),  // YYYY-MM-DD, the day being measured
      unitNumber:     a.string().required(),  // denormalised for display
      weekStart:      a.string().required(),  // YYYY-MM-DD Sunday that opened this week
      startOdometer:  a.float(),              // miles at 00:00 local; absent when Motive reported nothing
      endOdometer:    a.float(),              // miles at 23:59 local
      miles:          a.float(),              // endOdometer - startOdometer, never negative
      fuelGallons:    a.float(),              // gallons burned that day: driving + idle, from Motive
      mpg:            a.float(),              // miles / gallons; absent when the day cannot report one
      source:         a.string().required(),  // 'motive'
      syncedAt:       a.datetime().required(),
    })
    .identifier(['truckId', 'date'])
    // Only the week index: identifier(['truckId','date']) already makes
    // truckId+date the table's own key, so a truckId/date GSI would be a second
    // copy of the table paid for in write throughput and stack resources.
    .secondaryIndexes((index) => [index('weekStart')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Per-truck mileage from Motive ELD ─────────────────────────────────────
  // Stored per truck per period (WEEK or MONTH). Idempotent: re-syncing the
  // same (truckId, periodStart, periodType) overwrites the existing record.
  // Lambda writes directly via DynamoDB SDK; frontend reads via AppSync.
  TruckMileage: a
    .model({
      truckId:     a.string().required(),   // Equipment.id
      unitNumber:  a.string().required(),   // denormalised for display
      periodStart: a.string().required(),   // YYYY-MM-DD — week Monday or month 1st
      periodType:  a.string().required(),   // 'WEEK' | 'MONTH'
      miles:       a.float().required(),
      /*
       * US gallons burned in the same period, driving plus idle, from Motive.
       *
       * Optional because it arrives from a different endpoint than the miles and may be
       * absent for an older record or a vehicle Motive has no fuel data for. A null means
       * "not known", and MPG is simply not shown — never a zero, which would read as a
       * truck that burned nothing.
       */
      gallons:     a.float(),
      source:      a.string().required(),   // 'motive'
      syncedAt:    a.datetime().required(),
    })
    .identifier(['truckId', 'periodStart', 'periodType'])
    .secondaryIndexes((index) => [
      index('truckId').sortKeys(['periodStart']),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Current truck location from Motive ELD ────────────────────────────────
  // One record per truck (truckId = Equipment.id as PK). Upserted every sync so
  // it always holds the latest known position. Lambda writes via DynamoDB SDK;
  // dashboard map reads via AppSync.
  TruckLocation: a
    .model({
      truckId:     a.string().required(),   // Equipment.id — used as PK
      unitNumber:  a.string().required(),   // denormalised for display, e.g. "009"
      lat:         a.float().required(),
      lon:         a.float().required(),
      bearing:     a.float(),               // heading in degrees, may be absent
      speed:       a.float(),               // mph (X-Metric-Units: false), may be null
      locatedAt:   a.string().required(),   // ISO timestamp Motive reported the fix
      description: a.string(),              // human-readable, e.g. "4.5 mi NE of Tucson, AZ"
      motion:      a.string(),              // 'MOVING' | 'STATIONARY' (derived from speed)
      motionSince: a.string(),              // ISO timestamp the truck entered its current motion state
      odometer:    a.float(),               // latest odometer (miles) from Motive, if reported (fractional)
      source:      a.string().required(),   // 'motive'
      syncedAt:    a.datetime().required(),
    })
    .identifier(['truckId'])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Truck location breadcrumb history ─────────────────────────────────────
  // One record per truck per fix (truckId + locatedAt). Powers the breadcrumb
  // trail drawn when a truck marker is clicked on the dashboard map.
  TruckLocationHistory: a
    .model({
      truckId:     a.string().required(),   // Equipment.id
      locatedAt:   a.string().required(),   // ISO timestamp — sort key
      unitNumber:  a.string().required(),
      lat:         a.float().required(),
      lon:         a.float().required(),
      bearing:     a.float(),
      speed:       a.float(),
      description: a.string(),
      source:      a.string().required(),   // 'motive'
      syncedAt:    a.datetime().required(),
    })
    .identifier(['truckId', 'locatedAt'])
    .secondaryIndexes((index) => [
      index('truckId').sortKeys(['locatedAt']),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Open engine fault codes (DTCs) from Motive ────────────────────────────
  // One record per truck per open Motive fault code, refreshed hourly by the
  // motive-fault-sync Lambda: it writes every code Motive reports as `open` and
  // deletes the rows Motive no longer reports, so the table IS the current fault
  // list. Nothing here is entered by hand.
  TruckFaultCode: a
    .model({
      truckId:         a.string().required(),  // Equipment.id, or `motive:<number>` when unmatched
      faultId:         a.string().required(),  // Motive fault_code id — sort key
      unitNumber:      a.string().required(),  // denormalised for display, e.g. "009"
      code:            a.string().required(),  // code_label, e.g. "SPN-3563"
      description:     a.string(),             // code_description
      sourceLabel:     a.string(),             // source_address_label, e.g. "Engine #2"
      fmiDescription:  a.string(),             // what the failure mode means in plain English
      faultType:       a.string(),             // Motive `type`, e.g. "constant"
      occurrenceCount: a.integer(),
      firstObservedAt: a.string(),             // ISO — when Motive first saw the code
      lastObservedAt:  a.string(),             // ISO — most recent observation
      vehicleMake:     a.string(),
      vehicleModel:    a.string(),
      network:         a.string(),             // 'j1939' | 'obd2' …
      source:          a.string().required(),  // 'motive'
      syncedAt:        a.datetime().required(),
    })
    .identifier(['truckId', 'faultId'])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Driver availability (dispatch-entered, calendar display only) ─────────────
  // Covers full days off and partial availability (early/late start).
  // Multi-day ranges supported via startDate/endDate pair.
  DriverAvailability: a
    .model({
      driverId:  a.string().required(),
      type:      a.enum(['FULL_DAY_OFF', 'EARLY_START', 'LATE_START']),
      startDate: a.string().required(),   // YYYY-MM-DD
      endDate:   a.string().required(),   // YYYY-MM-DD (= startDate for single day)
      time:      a.string(),              // "HH:MM" for EARLY_START / LATE_START
      note:      a.string(),
      createdBy: a.string().required(),
    })
    .secondaryIndexes((index) => [
      index('driverId').sortKeys(['startDate']),
    ])
    .authorization((allow) => [allow.authenticated()]),

  // ── DOT compliance & onboarding ────────────────────────────────────────────
  // Internal models use allow.authenticated() like the rest of the schema.
  // The driver portal does NOT get AppSync access — it goes through a dedicated
  // Lambda (Phase 3) that validates the invite token server-side and reads/writes
  // via the DynamoDB SDK, so no public auth modes are exposed on these models.

  // Powers the driver onboarding portal. One active invite per driver at a time;
  // resending revokes the old token and issues a new one.
  OnboardingInvite: a
    .model({
      driverId:       a.string().required(),
      email:          a.string().required(),
      driverType:     a.enum(['COMPANY', 'OWNER_OPERATOR']),   // set at invite time — determines checklist
      token:          a.string().required(),   // 32+ bytes crypto-random, URL-safe
      status:         a.enum(['SENT', 'OPENED', 'IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'REVOKED']),
      expiresAt:      a.datetime().required(),  // default 14 days, extendable
      sentAt:         a.datetime(),
      openedAt:       a.datetime(),
      lastActivityAt: a.datetime(),
      requestCount:   a.integer(),              // simple per-token rate limiting (Phase 3)
    })
    .secondaryIndexes((index) => [
      index('driverId'),
      index('token'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // A "send for signature" request for a Driver Documents form (e.g. the WI Independent
  // Contractor Status statement). The office creates one; the driver opens /sign/<token>,
  // fills + e-signs, and the portal Lambda stores the signed PDF on their compliance
  // record and flips this to SIGNED. Token is validated server-side (raw DynamoDB), so
  // the model itself is only authenticated-facing for the office UI.
  DocumentSignatureRequest: a
    .model({
      driverId:             a.string().required(),
      driverName:           a.string(),
      documentType:         a.string().required(),   // e.g. 'ic_status_wi'
      documentTitle:        a.string(),
      token:                a.string().required(),    // URL-safe crypto-random
      status:               a.enum(['SENT', 'OPENED', 'SIGNED', 'VOIDED']),
      sentTo:               a.string(),               // recipient email (record only)
      valuesJson:           a.json(),                 // filled form values, captured on sign
      complianceDocumentId: a.string(),               // linked signed ComplianceDocument
      signedAt:             a.datetime(),
      signerIp:             a.string(),
      createdBy:            a.string(),
    })
    .secondaryIndexes((index) => [
      index('driverId'),
      index('token'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // The 49 CFR 391.21 employment application, filled by the driver in the portal.
  // NEVER collect or store a full SSN here — last 4 only.
  DriverApplication: a
    .model({
      driverId:        a.string().required(),
      // Personal
      legalName:       a.string(),
      dob:             a.date(),
      ssnLast4:        a.string(),    // LAST 4 ONLY
      phone:           a.string(),
      currentAddress:  a.string(),
      addressHistory:  a.json(),      // 3 years of residences
      // License
      cdlNumber:       a.string(),
      cdlState:        a.string(),
      cdlClass:        a.string(),
      endorsements:    a.string().array(),
      cdlExpiration:   a.date(),
      priorLicenses:   a.json(),
      // Employment history — JSON array; ≥3yr coverage (10yr for CDL); gaps > 30d explained
      employmentHistory: a.json(),
      // Driving record
      accidents:       a.json(),      // last 3 years
      violations:      a.json(),      // last 3 years
      // ELDT
      cdlIssuedAfterFeb2022: a.boolean(),
      eldtProviderName: a.string(),   // conditional
      // Certification (electronic signature per FMCSA: typed name + timestamp + attestation)
      signatureName:   a.string(),
      signedAt:        a.datetime(),
      ipAddress:       a.string(),
      status:          a.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']),
      reviewedBy:      a.string(),
      reviewedAt:      a.datetime(),
      rejectionReason: a.string(),
    })
    .secondaryIndexes((index) => [
      index('driverId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // One generic document model for both drivers and trucks.
  // Replacing a document creates a NEW record (history preserved for audits).
  ComplianceDocument: a
    .model({
      entityType:      a.enum(['DRIVER', 'TRUCK']),
      entityId:        a.string().required(),
      documentType:    a.string().required(),   // key from the requirement catalog
      title:           a.string().required(),
      s3Key:           a.string(),              // optional — some items are confirmations, not files
      issueDate:       a.date(),
      expirationDate:  a.date(),                // null = non-expiring
      status:          a.enum(['PENDING_REVIEW', 'VALID', 'EXPIRING_SOON', 'EXPIRED', 'REJECTED', 'MISSING', 'WAIVED']),
      uploadedBy:      a.enum(['DRIVER_PORTAL', 'INTERNAL']),
      rejectionReason: a.string(),              // shown to the driver in the portal
      waivedReason:    a.string(),
      notes:           a.string(),
      verifiedBy:      a.string(),              // username
      verifiedAt:      a.datetime(),
    })
    .secondaryIndexes((index) => [
      index('entityId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // A single checklist item generated from the requirement catalog per classification.
  OnboardingTask: a
    .model({
      entityType:           a.enum(['DRIVER', 'TRUCK']),
      entityId:             a.string().required(),
      requirementKey:       a.string().required(),
      label:                a.string().required(),
      category:             a.string().required(),
      required:             a.boolean().required(),
      requiresDocument:     a.boolean().required(),
      requiresExpiration:   a.boolean().required(),
      driverVisible:        a.boolean().required(),   // appears in driver portal?
      driverActionable:     a.boolean().required(),   // driver can upload vs view-only
      status:               a.enum(['PENDING', 'AWAITING_DRIVER', 'PENDING_REVIEW', 'COMPLETE', 'WAIVED', 'NOT_APPLICABLE']),
      completedBy:          a.string(),
      completedAt:          a.datetime(),
      complianceDocumentId: a.string(),               // optional link
      sortOrder:            a.integer().required(),
      // ── Phased-template onboarding (all optional; legacy tasks read null) ──
      // Added for the Amazon driver onboarding flow. Ivan/Local tasks leave these null.
      phase:               a.integer(),               // 1-based phase index within the template
      owner:               a.enum(['DRIVER', 'OFFICE']),  // who is responsible for the task
      assignee:            a.string(),                // specific staff/driver assigned
      dueDate:             a.string(),                // YYYY-MM-DD
      templateId:          a.string(),                // OnboardingTemplate.id
      catalogVersion:      a.string(),                // CATALOG_VERSION at generation time
      links:               a.json(),                  // [{label,url}] form/policy links shown in the portal (editable)
    })
    .secondaryIndexes((index) => [
      index('entityId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Created by the Phase 2 compliance-scanner. Model defined now.
  ComplianceAlert: a
    .model({
      entityType:     a.enum(['DRIVER', 'TRUCK']),
      entityId:       a.string().required(),
      entityName:     a.string(),               // denormalized
      documentType:   a.string().required(),
      documentTitle:  a.string(),
      complianceDocumentId: a.string(),         // link back to the document
      expirationDate: a.date(),
      severity:       a.enum(['UPCOMING', 'URGENT', 'CRITICAL', 'EXPIRED']), // 31-60d / 8-30d / 0-7d / past
      acknowledged:   a.boolean().required(),
      acknowledgedBy: a.string(),
      acknowledgedAt: a.datetime(),
      emailSentAt:    a.datetime(),             // Phase 4
      resolvedAt:     a.datetime(),             // set when the document is renewed/replaced
    })
    // NOTE: Amplify GSIs can't key on a boolean, so there is no index on `acknowledged`.
    // The alert set is small; open-vs-acknowledged filtering is done client-side
    // (consistent with FuelTransaction/IntakeItem in this schema).
    .secondaryIndexes((index) => [
      index('entityId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Phase 4: expiration escalation rules. Admin-editable via /compliance settings.
  EscalationRule: a
    .model({
      documentType:         a.string().required(),   // a catalog key, or 'ALL'
      daysBeforeExpiration: a.integer().required(),  // 30 / 14 / 7 / 0
      recipients:           a.enum(['DRIVER', 'MANAGER', 'BOTH']),
      templateKey:          a.string().required(),
      active:               a.boolean().required(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Phase 4: one record per escalation email sent. Powers per-(alert, rule) dedup in
  // the scanner and the "Email history" sub-tab on the alert detail.
  EscalationEmailLog: a
    .model({
      alertId:              a.string().required(),
      entityType:           a.enum(['DRIVER', 'TRUCK']),
      entityName:           a.string(),
      documentType:         a.string(),
      daysBeforeExpiration: a.integer().required(),  // the rule threshold that fired
      templateKey:          a.string(),
      recipients:           a.string().array(),      // actual addresses emailed
      sentAt:               a.datetime().required(),
    })
    .secondaryIndexes((index) => [
      index('alertId'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Phase 3/4: single-row settings records (e.g. id 'GLOBAL') for kill switches and
  // manager-recipient lists. Both email paths default to PAUSED.
  ComplianceSettings: a
    .model({
      settingsKey:          a.string().required(),   // 'GLOBAL'
      portalEmailsPaused:   a.boolean().required(),   // default true (PAUSED)
      escalationEmailsPaused: a.boolean().required(), // default true (PAUSED)
      managerEmails:        a.string().array(),       // escalation manager recipients
      // documentTypes hidden from everyone except admins — pay-term paperwork the fleet
      // manager must not see. Editable here so it changes without a deploy.
      // NOTE: presentation-level only; the documents remain readable via the API.
      privateDocumentTypes: a.string().array(),
      // documentType → 'OFFICE' | 'DRIVER'. Who maintains each document; overrides the
      // catalog default so it can change without a deploy.
      documentResponsibility: a.json(),
    })
    .secondaryIndexes((index) => [
      index('settingsKey'),
    ])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Editable onboarding template (phased flows). One row per templateId (e.g.
  // 'amazon-driver-v1') holding the full phases[] as JSON. When present, kickoff reads
  // this instead of the code default, so staff can edit what onboarding looks like.
  OnboardingTemplateConfig: a
    .model({
      templateId: a.string().required(),   // e.g. 'amazon-driver-v1' — PK
      label:      a.string(),
      phases:     a.json(),                 // OnboardingPhase[] (see src/lib/onboardingTemplates.ts)
      updatedBy:  a.string(),
    })
    .identifier(['templateId'])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Fleet insurance ─────────────────────────────────────────────────────────
  // Insurance is entered per named PERIOD (a policy term, e.g. "2026 Policy Year") so the
  // Insurance page can compare spend period-over-period. One InsurancePeriod holds many
  // InsuranceLineItems: a per-truck or per-trailer annual amount, or a single workmans-comp
  // total. All amounts are ANNUAL and stored in cents (app convention; monthly = /12).
  InsurancePeriod: a
    .model({
      label:     a.string().required(),   // e.g. "2026 Policy Year"
      startDate: a.string(),              // YYYY-MM-DD (optional)
      endDate:   a.string(),              // YYYY-MM-DD (optional)
      isCurrent: a.boolean(),             // the period used for the "current insurance cost" card
      notes:     a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  InsuranceLineItem: a
    .model({
      periodId:    a.string().required(), // InsurancePeriod.id
      kind:        a.string().required(), // 'TRUCK' | 'TRAILER' | 'WORKMANS_COMP'
      equipmentId: a.string(),            // Equipment.id for TRUCK/TRAILER; empty for WORKMANS_COMP
      unitNumber:  a.string(),            // denormalised for display
      annualCents: a.integer().required(),// annual insurance amount, in cents
      notes:       a.string(),
    })
    .secondaryIndexes((index) => [index('periodId')])
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // Notify Slack when an IntakeItem status changes.
  // Called fire-and-forget from the frontend after a successful updateIntakeItem.
  notifySlackStatusChange: a
    .mutation()
    .arguments({
      intakeItemId: a.id().required(),
      oldStatus:    a.string(),
      newStatus:    a.string().required(),
      actorName:    a.string(),
      proNumber:    a.string(),     // included in DONE message for BCAT items
      reassignedTo: a.string(),     // set (display name) when posting a reassignment reply
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(slackStatusNotifier)),

  manageUsers: a
    .query()
    .arguments({
      action:   a.string().required(),
      email:    a.string(),
      username: a.string(),
      pages:    a.string(),
      isAdmin:  a.boolean(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(userManagement)),

  // Send a driver-facing onboarding email via SES.
  // 'invite' starts the hiring paperwork; 'appInvite' gives an already-hired driver a
  // link to set up their driver-app sign-in. Honors the portalEmailsPaused kill switch
  // (default PAUSED) inside the Lambda for every type EXCEPT appInvite, which a person
  // presses by hand for one driver and therefore must actually send.
  sendOnboardingEmail: a
    .mutation()
    .arguments({
      type:          a.string().required(),   // 'invite' | 'appInvite' | 'rejected' | 'declined' | 'complete'
      driverId:      a.string(),
      inviteId:      a.string(),
      itemLabel:     a.string(),
      reason:        a.string(),
      portalBaseUrl: a.string(),               // caller's origin → correct portal link in the email
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(onboardingEmailer)),

  // Email a driver their weekly pay statement as a PDF attachment. The frontend
  // builds the branded PDF (jsPDF) and passes it as base64; the Lambda wraps it in
  // a MIME message and sends via SES.
  sendDriverPayEmail: a
    .mutation()
    .arguments({
      to:          a.string().required(),
      cc:          a.string(),
      driverName:  a.string(),
      periodLabel: a.string(),
      subject:     a.string(),
      bodyText:    a.string(),
      filename:    a.string(),
      pdfBase64:   a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(driverPayEmailer)),

  // Read an Amazon Relay trips-list screenshot into structured trip rows for the
  // Driver Pay import (upload or paste an image instead of a CSV). The frontend
  // downscales the image and previews the rows before anything is saved.
  // Read a rate confirmation (PDF/image) into pickup/delivery appointment date-times.
  // Non-Batory loads auto-fill + auto-confirm their appts from this.
  // Send an appointment-request email to a facility's appt contact (Appts page).
  sendApptRequestEmail: a
    .mutation()
    .arguments({
      to:      a.string().required(),
      cc:      a.string(),
      subject: a.string().required(),
      body:    a.string().required(),
      replyTo: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(apptRequestEmailer)),

  parseRateConfirm: a
    .mutation()
    .arguments({
      fileBase64: a.string().required(),
      mediaType:  a.string(),
      todayISO:   a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(rateconParser)),

  parseTripScreenshot: a
    .mutation()
    .arguments({
      imageBase64: a.string().required(),
      mediaType:   a.string(),
      todayISO:    a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(tripScreenshotParser)),

  // Email a customer their Best Care Auto Transport vehicle quote as branded HTML.
  // The frontend builds the HTML (identical to the on-screen preview); the Lambda
  // sends it from ruben@bcatcorp.com and always BCCs cars@bcatcorp.com.
  sendVehicleQuoteEmail: a
    .mutation()
    .arguments({
      to:      a.string().required(),
      subject: a.string().required(),
      html:    a.string().required(),
      replyTo: a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(vehicleQuoteEmailer)),

  // ── Cash Flow (STANDALONE) ──────────────────────────────────────────────────
  // A manual weekly cash-flow forecast for BCAT + IVAN. These two tables are
  // deliberately isolated: no relations, no shared IDs, and nothing else in the app
  // reads or writes them. Every value is typed in on the Cash Flow page. Do NOT wire
  // these to Load/Invoice/ExpenseRecord — the page's whole premise is that the
  // operator enters the numbers by hand.
  //
  // Money is stored in integer cents, same as the insurance module.

  // The current input set. One active row (isCurrent) is read on page load; older
  // rows are kept so an input set can be traced back if a figure is questioned.
  CashFlowInputs: a
    .model({
      weekOf:                  a.date().required(),
      isCurrent:               a.boolean().required(),
      cashBcatCents:           a.integer().required(),
      cashIvanCents:           a.integer().required(),
      ar30Cents:               a.integer().required(),
      ar120Cents:              a.integer().required(),
      ar120CollectionRate:     a.float().required(),   // 0–1
      apBcatAgingCents:        a.integer().required(),
      apBcatExpectedCents:     a.integer().required(),
      apBcatAmexCents:         a.integer().required(),
      apIvanCcCents:           a.integer().required(),
      apIvanMiscCents:         a.integer().required(),
      recurringRevenueCents:   a.integer().required(),
      recurringExpensesCents:  a.integer().required(),
      // Months the payables backlog is spread over (1 = pay it all in month 1).
      payablesSpreadMonths:    a.integer(),
      minCashThresholdCents:   a.integer(),
      notes:                   a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // One appended row per week — the history log behind the trend chart. Snapshots the
  // headline figures plus the projection it produced, so a past week still shows the
  // forecast it was based on even after the model's assumptions change.
  CashFlowWeekLog: a
    .model({
      weekOf:               a.date().required(),
      totalCashCents:       a.integer().required(),
      ar30Cents:            a.integer().required(),
      ar120Cents:           a.integer().required(),
      totalPayablesCents:   a.integer().required(),
      projectedLowCents:    a.integer().required(),
      projectedEndingCents: a.integer().required(),
      // Months of runway at the time of the snapshot. Null = wasn't burning that week,
      // which is meaningfully different from zero and must not collapse into it.
      runwayMonths:         a.integer(),
      notes:                a.string(),
    })
    // No client subscribes to this model (see TMS_DESIGN §12): dropping the three
    // subscription resolvers keeps a fresh stack create under the CloudFormation cap.
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated()]),

  // ── Weekly Cash Check-in ───────────────────────────────────────────────────
  // Cash check-ins and the assumptions that drive the cash outlook. ADMIN group has
  // full CRUD; every authenticated user can read. Floats are whole dollars on the
  // frontend; the JSON fields hold the run-rate, one-time items, and factoring scenario.

  CashCheckIn: a
    .model({
      date:            a.string().required(),   // YYYY-MM-DD
      cash:            a.float().required(),    // whole dollars
      ar:              a.float(),               // receivables outstanding
      ap:              a.float(),               // payables outstanding
      cards:           a.float(),               // credit cards owed
      bcatMtdProfit:   a.float(),               // BCAT month-to-date profit
      ivanMtdProfit:   a.float(),               // Ivan month-to-date profit
      amazonMtdProfit: a.float(),               // Amazon DSP month-to-date profit
      note:            a.string(),
      createdBy:       a.string(),              // user email
    })
    .authorization((allow) => [
      allow.groups(['ADMIN']),
      allow.authenticated().to(['read']),
    ]),

  CashSettings: a
    .model({
      id:        a.id().required(),         // 'default'
      floor:     a.float().default(25000),  // cash floor to hold
      months:    a.integer().default(12),   // months in outlook (3..12)
      runrate:   a.json().required(),       // Record<center,{fixed,profit,lagMonths}>
      items:     a.json().required(),       // {ym,label,amount}[]
      factoring: a.json().required(),       // {on,start,stop,eligible,fee,advance}
      // Biweekly Slack reminder: the morning after every 14th day from payrollAnchor,
      // posted to slackChannel by the cash-checkin-reminder Lambda. Blank = off.
      payrollAnchor: a.string(),            // YYYY-MM-DD of a payroll day
      slackChannel:  a.string(),            // Slack channel/user ID
      lastReminderFor: a.string(),          // payroll date (YYYY-MM-DD) last reminded about — re-run guard
    })
    .authorization((allow) => [
      allow.groups(['ADMIN']),
      allow.authenticated().to(['read']),
    ]),

  // Post to Slack #appts-ivan about an appointment. Fired by the client on a TRANSITION
  // only — into NEED, or a time change on a stop already asked about — so re-saving a
  // load stays quiet.
  //
  // `kind: 'updated'` with a `threadTs` replies inside the thread that asked, which is
  // what keeps one appointment's history in one place instead of scattered posts.
  // Returns { ok, ts }; the caller persists ts on the stop as apptThreadTs.
  notifyApptNeeded: a
    .mutation()
    .arguments({
      stopKind:     a.string().required(),   // 'pickup' | 'delivery'
      kind:         a.string(),              // 'needed' (default) | 'updated'
      threadTs:     a.string(),              // reply into this thread when updating
      apptLabel:    a.string(),              // e.g. "Aug 20, 2026 · 09:30"
      aljexId:      a.string(),
      pickupNumber: a.string(),
      customer:     a.string(),
      location:     a.string(),
      apptDate:     a.string(),
      actorName:    a.string(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(apptNeedNotifier)),

  // Live Google rating + review count for the Best Care Auto Transport listing,
  // shown as a CTA in the quote email. Returns { configured, ok, rating, total, url }.
  getGoogleReviews: a
    .query()
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(googleReviews)),

  // Phase 1: all directory, config, and load writes route through this Lambda.
  // Actions: UPSERT_CUSTOMER, UPSERT_LOCATION, ARCHIVE_CUSTOMER, ARCHIVE_LOCATION,
  // SAVE_DIVISION, SAVE_SETTINGS, PREVIEW_MERGE_LOCATIONS, MERGE_LOCATIONS, RESUME_MERGE.
  // Loads stay on the generated mutations; the merge repoint is the only Load write here.
  tmsDirectoryActions: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(tmsDirectoryActions)),

  // Step B: every Shipment / Order / Load-carrier / charge write goes through this
  // Lambda. Actions: CREATE_SHIPMENT, SAVE_ORDER_FORM, CHECK_CREDIT, SUBMIT_ORDER,
  // SET_SHIPMENT_STATUS, SET_LOAD_STATUS, DELETE_SHIPMENT, RESTORE_SHIPMENT,
  // TENDER_RESPOND, DUPLICATE_SHIPMENT, UPDATE_STOP, ASSIGN_ASSET, ASSIGN_CARRIER,
  // REMOVE_LOAD_CARRIER, RECALC_CHARGES, SET_AR_STATUS, GET_SHIPMENT_BUNDLE.
  // Load itself is written with the generated updateLoad mutation so the calendar's
  // subscriptions still fire.
  tmsShipmentActions: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(tmsShipmentActions)),

  // Step C: every carrier-directory write goes through this Lambda. Actions:
  // UPSERT_CARRIER, SET_CARRIER_STATUS, UPSERT_CONTACT, ARCHIVE_CONTACT,
  // UPSERT_PAYMENT_METHOD, ARCHIVE_PAYMENT_METHOD, PREPARE_DOCUMENT,
  // COMMIT_DOCUMENT, DELETE_DOCUMENT, SAVE_CARRIER_SETTINGS.
  // Booking a carrier onto a load is tmsShipmentActions' BOOK_CARRIER — that is
  // where the transaction across the shipment tables already lives.
  tmsCarrierActions: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(tmsCarrierActions)),

  // Step D: tracking links and the texts/e-mails that carry them. Kept off
  // tmsShipmentActions so Twilio, SES, Cognito and the dispatch tables stay off
  // that router's role. Actions: SEND_TRACKING_LINK, REVOKE_TRACKING_LINK,
  // SEND_CUSTOMER_LINK, REVOKE_CUSTOMER_LINK, TEXT_DRIVER, SAVE_TRACKING_SETTINGS.
  // Logging a check call moves Load status and money, so it stays in tmsShipmentActions.
  tmsTrackingActions: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(tmsTrackingActions)),

  // Phase 1: server-side geocoding, Places autocomplete, and place details.
  tmsGeocode: a
    .query()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(tmsGeocode)),

  // JobsDone POD custom action router. All access goes through this mutation so
  // the backend controls tenant isolation, S3 presigned URLs, and conditional writes.
  managePods: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(podActions)),

  // OTR Solutions factoring router. Actions: resolve, assemble, setMc,
  // brokerCheck, submit, syncStatus. Submitting is human-initiated only — the
  // handler refuses unless every required field and both documents are present.
  manageOtr: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(otrActions)),

  // ── Dispatch: texts and calls with drivers through the Twilio number ──────
  // Rows are written by the two dispatch Lambdas; the page only reads. One row per phone.
  DispatchConversation: a
    .model({
      phone:         a.string().required(),   // E.164
      driverId:      a.string(),
      driverName:    a.string(),              // snapshot for the list; re-resolved on link
      displayName:   a.string(),              // staff label for a number that is not a driver
      status:        a.enum(['OPEN', 'ARCHIVED']),
      lastMessageAt: a.datetime(),
      lastPreview:   a.string(),
      lastDirection: a.enum(['IN', 'OUT']),
      lastKind:      a.string(),
      lastSentBy:    a.string(),              // staff email behind the last OUT message
      lastStatusAt:  a.datetime(),            // the driver's last app status update (on site, departed, POD…)
      lastStatusText: a.string(),
      unreadCount:   a.integer(),
      assignedTo:    a.string(),              // primary dispatcher (staff email)
      assignedBackup: a.string(),             // backup dispatcher
      nudgedFor:     a.datetime(),            // the lastMessageAt a Slack nudge was sent for
      nudgeStage:    a.integer(),             // 1 = primary pinged, 2 = backup pinged
      lastReadAt:    a.datetime(),
      lastReadBy:    a.string(),
      slackChannelId:   a.string(),           // the driver's own Slack channel (bridge)
      slackChannelName: a.string(),
    })
    .secondaryIndexes((index) => [index('phone'), index('slackChannelId')])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  DispatchMessage: a
    .model({
      conversationId:  a.string().required(),
      phone:           a.string().required(),
      direction:       a.enum(['IN', 'OUT']),
      kind:            a.enum(['SMS', 'MMS', 'CALL', 'VOICEMAIL', 'NOTE', 'STATUS']),   // STATUS: driver-app stop events
      body:            a.string(),
      media:           a.json(),              // [{ key, contentType }] in S3 dispatch-media/
      twilioSid:       a.string(),            // MessageSid / CallSid / RecordingSid
      status:          a.string(),            // received|queued|sent|delivered|failed|ringing|answered|missed|voicemail
      errorCode:       a.string(),
      errorMessage:    a.string(),
      sentBy:          a.string(),            // staff email for OUT
      at:              a.datetime().required(),
      callDurationSec: a.integer(),
      recordingKey:    a.string(),
      transcript:      a.string(),
      via:             a.string(),            // 'app' | 'slack' for OUT
      slackTs:         a.string(),
    })
    .secondaryIndexes((index) => [
      index('conversationId').sortKeys(['at']),
      index('twilioSid'),
    ])
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Single row (id 'default'): who the phones ring, voicemail, Slack, auto-reply.
  DispatchSettings: a
    .model({
      forwardTo:        a.json(),             // [{ name, phone }]
      ringSeconds:      a.integer(),
      greeting:         a.string(),
      voicemailEnabled: a.boolean(),
      slackChannelId:   a.string(),
      autoReply:        a.string(),
      introText:        a.string(),           // the first text to a driver; {name} and {number} are filled in
      slackMirror:      a.boolean(),          // one Slack channel per driver, both ways
      slackInviteEmails: a.json(),            // staff emails invited into every driver channel
      dispatcherContacts: a.json(),           // [{ email, name, phone }] — a driver's dispatcher's own number, shown in their app
    })
    .disableOperations(['subscriptions'])
    .authorization((allow) => [allow.authenticated().to(['read'])]),

  // Dispatch router: send, start, markRead, assign, link, archive, reopen, note,
  // mediaUrl, status, getSettings, saveSettings. Requires the page-dispatch group.
  manageDispatch: a
    .mutation()
    .arguments({
      action: a.string().required(),
      input:  a.json(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(dispatchActions)),
}).authorization((allow) => [
  // Phase 1: tmsDirectoryActions Lambda invokes the AppSync API via IAM auth
  // (generated mutations for Load, plus queries for Customer/Location/Division/etc.).
  allow.resource(tmsDirectoryActions).to(['query', 'mutate']),
  // Step B: tmsShipmentActions writes Load through the generated updateLoad mutation
  // for the same reason (subscriptions), and reads Customer/TmsSettings/Driver.
  allow.resource(tmsShipmentActions).to(['query', 'mutate']),
  // Step C: tmsCarrierActions owns the four carrier tables through the SDK and
  // reaches the generated queries over IAM for the rows it only reads.
  allow.resource(tmsCarrierActions).to(['query', 'mutate']),
  // Step D: tmsTrackingActions owns TrackingLink through the SDK and reads
  // Shipment/Order/Load/LoadCarrier/Customer over IAM.
  allow.resource(tmsTrackingActions).to(['query', 'mutate']),
])

export type Schema = ClientSchema<typeof schema>

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
})
