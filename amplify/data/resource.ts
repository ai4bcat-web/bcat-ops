import { type ClientSchema, a, defineData } from '@aws-amplify/backend'
import { userManagement } from '../functions/userManagement/resource'
import { slackStatusNotifier } from '../functions/slack-status-notifier/resource'
import { onboardingEmailer } from '../functions/onboarding-emailer/resource'
import { driverPayEmailer } from '../functions/driver-pay-emailer/resource'
import { vehicleQuoteEmailer } from '../functions/vehicle-quote-emailer/resource'
import { googleReviews } from '../functions/google-reviews/resource'

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
      hot:             a.boolean(),  // urgent/"hot" load — flagged with 🔥 in schedule
      unscheduled:     a.boolean(),  // true = orphan (no firm date) → parked in the calendar's Unscheduled lane
      // Canonical multi-stop array: Stop[] (see src/lib/stops.ts). The legacy pickup*/
      // delivery*/origin*/destination*/*DriverId fields above are dual-written mirrors
      // derived from stops (first pickup → pickup*, last delivery → delivery*).
      stops:           a.json(),
      createdBy:       a.string().required(),
      updatedBy:       a.string().required(),
    })
    .authorization((allow) => [allow.authenticated()]),

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
    })
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
      // Fleet grouping for profitability — LOCAL (Ivan) vs AMAZON. Optional: legacy
      // records read null and are treated as "ungrouped" by the profitability view.
      // This is the SOURCE OF TRUTH for fleet membership (no hardcoded unit lists).
      fleetGroup:              a.enum(['LOCAL', 'AMAZON']),
      // Preventive-maintenance (PM) tracking — Ivan/LOCAL fleet runs a PM every 25k mi.
      // lastPmMileage is the odometer reading at the last PM service; the Fleet Manager
      // Dashboard counts down to the next PM (lastPmMileage + 25000) using live mileage.
      lastPmDate:              a.string(),   // YYYY-MM-DD of the last PM service
      lastPmMileage:           a.integer(),  // odometer at the last PM
      notes:                   a.string(),
    })
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
    .authorization((allow) => [allow.authenticated()]),

  // ── Amazon driver pay ──────────────────────────────────────────────────────
  // Weekly (7-day) trip-based pay for Amazon drivers. AmazonTrip = one freight load
  // line; DriverPaySetting = per-driver pay model (% + expense timing + fuel card +
  // fixed weekly deductions); DriverPayDeduction = per-week one-off charges. Fuel is
  // pulled live from FuelTransaction by the driver's fuel card. See src/lib/driverPay.ts.
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
      source:          a.enum(['GOOGLE_FORM', 'MANUAL']),
      externalId:      a.string(),             // dedup key from the form submission
      notes:           a.string(),             // internal staff notes
    })
    .secondaryIndexes((index) => [index('externalId')])
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
    .authorization((allow) => [allow.authenticated()]),

  DriverPaySetting: a
    .model({
      driverId:              a.string().required(),
      payGroup:              a.enum(['AMAZON', 'LOCAL', 'BOX_TRUCK']),
      payPercent:            a.float().required(),   // 0..1 (e.g. 0.42, 0.88)
      expensesBeforePercent: a.boolean().required(), // true = % applied AFTER expenses (Chad)
      email:                 a.string(),             // where the weekly report is sent
      fuelCardNumber:        a.string(),             // EFS card prefix → pulls weekly fuel
      fixedExpenses:         a.json(),               // [{ label, amount }] applied every week
      active:                a.boolean(),
      notes:                 a.string(),
    })
    .secondaryIndexes((index) => [index('driverId')])
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
    })
    .secondaryIndexes((index) => [index('equipmentId')])
    .authorization((allow) => [allow.authenticated()]),

  // ── Intake queue ──────────────────────────────────────────────────────────
  // Records created by the slack-intake-webhook Lambda when Slack messages arrive.
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
    })
    .secondaryIndexes((index) => [
      index('assignedTo').sortKeys(['receivedAt']),
      index('source').sortKeys(['receivedAt']),
      index('externalId'),
      index('gmailMessageId'),
    ])
    .authorization((allow) => [allow.authenticated()]),

  AuditLog: a
    .model({
      entityType: a.string().required(),
      entityId:   a.string().required(),
      action:     a.string().required(),
      user:       a.string().required(),
      changes:    a.json().required(),
    })
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
      active:        a.boolean().required(),
      notes:         a.string(),
    })
    .secondaryIndexes((index) => [
      index('expenseTypeId'),
    ])
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
      source:      a.string().required(),   // 'motive'
      syncedAt:    a.datetime().required(),
    })
    .identifier(['truckId', 'periodStart', 'periodType'])
    .secondaryIndexes((index) => [
      index('truckId').sortKeys(['periodStart']),
    ])
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
    .authorization((allow) => [allow.authenticated()]),

  // Phase 3/4: single-row settings records (e.g. id 'GLOBAL') for kill switches and
  // manager-recipient lists. Both email paths default to PAUSED.
  ComplianceSettings: a
    .model({
      settingsKey:          a.string().required(),   // 'GLOBAL'
      portalEmailsPaused:   a.boolean().required(),   // default true (PAUSED)
      escalationEmailsPaused: a.boolean().required(), // default true (PAUSED)
      managerEmails:        a.string().array(),       // escalation manager recipients
    })
    .secondaryIndexes((index) => [
      index('settingsKey'),
    ])
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
    .authorization((allow) => [allow.authenticated()]),

  // Admin-only: manage Cognito users via Lambda.
  // Authorization is allow.authenticated() so the Lambda receives the call and can
  // inspect event.identity.claims.email — the Lambda throws for non-admin callers.
  // Client-side: isAdminEmail() in AuthContext gates the UI and the nav link.
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

  // Send a driver-facing onboarding email via SES (invite / rejected / complete).
  // Honors the portalEmailsPaused kill switch (default PAUSED) inside the Lambda.
  sendOnboardingEmail: a
    .mutation()
    .arguments({
      type:          a.string().required(),   // 'invite' | 'rejected' | 'complete'
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

  // Live Google rating + review count for the Best Care Auto Transport listing,
  // shown as a CTA in the quote email. Returns { configured, ok, rating, total, url }.
  getGoogleReviews: a
    .query()
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(googleReviews)),
})

export type Schema = ClientSchema<typeof schema>

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
})
