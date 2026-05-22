import { type ClientSchema, a, defineData } from '@aws-amplify/backend'
import { userManagement } from '../functions/userManagement/resource'
import { slackStatusNotifier } from '../functions/slack-status-notifier/resource'

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
      daySlot:         a.integer(),  // display order badge 1-5 within pickup day
      notes:           a.string(),   // short free-text notes
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
      email:              a.string(),
      cdl:                a.string(),   // CDL number e.g. "CDL-A IL-8823901"
      cdlExpiration:      a.string(),   // YYYY-MM-DD
      medCardExpiration:  a.string(),   // YYYY-MM-DD
      drugTestDate:       a.string(),   // YYYY-MM-DD — last test date
      hireDate:           a.string(),   // YYYY-MM-DD
      driverType:         a.string(),   // 'company' | 'owner_op'
    })
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
      externalSource:       a.enum(['gmail', 'slack']),   // platform origin
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
      ownershipType:       a.enum(['COMPANY', 'OWNER_OPERATOR']),
      motiveVehicleId:     a.integer(),             // Motive integer vehicle ID
      motiveVehicleNumber: a.string(),              // Motive 'number' field (should = unitNumber)
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
})

export type Schema = ClientSchema<typeof schema>

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
})
