/**
 * Schema stages: deploy the merged data schema in several Amplify releases.
 *
 * Why: CloudFormation refuses one stack operation that creates/updates/deletes more than 2,500
 * resources across the nested stacks. Going from the 60-model production shape to the merged
 * 109-model tree in one release is over that (the rehearsal failed with "Limit on the number of
 * resources in a single stack operation exceeded"). So `BCAT_SCHEMA_STAGE=k` (an integer branch
 * environment variable) decides which part of the schema this synth contains.
 *
 *   unset, empty, not a number, or >= FINAL_STAGE  ->  EVERYTHING (dev, and every deploy today)
 *
 * Stage 0 is the production shape: the models production has today, the additive fields the merge
 * put on existing models (they create no resources, only schema/resolver churn), the new Lambdas.
 * Each later stage adds one batch. Nothing in stage k removes or renames anything from stage k-1;
 * `scripts/stageDeployCheck.mjs` proves it.
 *
 * Adding to the schema later needs NO edit here:
 *   - a field added to any model rides with its model (existing models: stage 0);
 *   - a model not listed in MODEL_STAGE lands in LAST_MODEL_STAGE (the last stage that creates
 *     tables). It never lands in FINAL_STAGE: that stage is the TruckLocationHistory TTL alone.
 *
 * NEVER lower BCAT_SCHEMA_STAGE on a deployed stack: the lower stage no longer contains the models
 * and CloudFormation DELETES their tables and data. See Docs/tms-build/AW_STAGED_DEPLOY.md.
 *
 * Resource deltas (created+updated+deleted CloudFormation resources per stage, measured by
 * scripts/stageDeployCheck.mjs against the prod-shape synth, production = main + feat/gsi-prep):
 * see the STAGE_NOTES table below; numbers are rewritten by hand from that script's output.
 */

export const STAGE_ENV = 'BCAT_SCHEMA_STAGE'

/**
 * The 60 models production has today (origin/main). Never edit; a model not here and not in
 * MODEL_STAGE is NEW and lands in LAST_MODEL_STAGE.
 */
export const PRODUCTION_MODELS: ReadonlySet<string> = new Set([
  'Load', 'Driver', 'TimeClockEntry', 'Equipment', 'DriverPayPeriod', 'AmazonTrip', 'AmazonDispute',
  'AmazonPayMaster', 'BoxTruckTrip', 'DriverPaySetting', 'DriverPayDeduction', 'DriverPayCredit',
  'DriverSubmission', 'DriverLoadTime', 'DriverSubmissionDoc', 'MaintenanceTask', 'MaintenanceInvoice',
  'Customer', 'Location', 'Division', 'TmsSettings', 'DirectoryMergeJob', 'IntakeItem', 'FactoringItem',
  'VendorPayable', 'PodDocument', 'PodSenderMapping', 'AuditLog', 'Feedback', 'FuelTransaction', 'ExpenseType',
  'TruckExpenseAllocation', 'ExpenseRecord', 'RecurringExpense', 'TruckConfig', 'TruckOdometerDay',
  'TruckMileage', 'TruckLocation', 'TruckLocationHistory', 'TruckFaultCode', 'DriverAvailability',
  'OnboardingInvite', 'DocumentSignatureRequest', 'DriverApplication', 'ComplianceDocument',
  'OnboardingTask', 'ComplianceAlert', 'EscalationRule', 'EscalationEmailLog', 'ComplianceSettings',
  'OnboardingTemplateConfig', 'InsurancePeriod', 'InsuranceLineItem', 'CashFlowInputs', 'CashFlowWeekLog',
  'CashCheckIn', 'CashSettings', 'DispatchConversation', 'DispatchMessage', 'DispatchSettings',
])

/** Models the merge added. Anything absent from this table is in LAST_MODEL_STAGE. */
export const MODEL_STAGE: Readonly<Record<string, number>> = {
  // Stage 1: carrier registry, ownership/directory, commissions, user profile, integrations, CRM.
  Carrier: 1, CarrierContact: 1, CarrierPaymentMethod: 1, CarrierDocument: 1, CompanyPhone: 1,
  OwnershipDivision: 1, OwnershipRule: 1, ShipmentView: 1, ShipmentColumnTemplate: 1,
  UserProfile: 1, Commission: 1, CommissionPayPeriod: 1,
  Integration: 1, SpotSettings: 1, GmailConnection: 1, SpotRequest: 1, ApInboxItem: 1,
  CrmContact: 1, CrmDomain: 1, CrmActivity: 1, CrmAccount: 1,
  // Stage 2: the shipment core (shipment, order, assignment, charges, check calls, links, documents).
  ProClaim: 2, Shipment: 2, Order: 2, LoadCarrier: 2, LoadFinancials: 2, LoadCharge: 2,
  LoadCheckCall: 2, TrackingLink: 2, ShipmentDocument: 2, ShipmentNotice: 2, ShipmentPosting: 2,
  ShipmentMessage: 2, IntakeLoad: 2, Quote: 2,
  // Stage 3: billing, the Aljex import engine, workflow, rollups, demo/lane data.
  Invoice: 3, ArPayment: 3, CarrierBill: 3, ApPayment: 3,
  ImportJob: 3, AljexImportJob: 3, AljexMappingProfile: 3, LegacyAljexRow: 3, AljexCodeMap: 3,
  DataExportJob: 3, WorkflowRun: 3, DemoRecord: 3, LaneRateSample: 3, DashboardRollup: 3,
}

/** The last stage that creates tables; models not in MODEL_STAGE land here. */
export const LAST_MODEL_STAGE = 3

/**
 * TruckLocationHistory timeToLiveAttribute (null -> ttlEpoch) on the EXISTING production table.
 * DynamoDB allows one TTL change per table per hour, so a stage that fails after this change
 * cannot roll back cleanly (UPDATE_ROLLBACK_FAILED). It is the only change in its stage.
 */
export const TTL_STAGE = 4

/** Stages are 0..FINAL_STAGE; FINAL_STAGE (and above, and unset) is the whole schema. */
export const FINAL_STAGE = TTL_STAGE

/**
 * Point-in-time recovery is NOT driven by the schema stage (incident 2026-11-07: flipping it on
 * 60 existing tables in one stage was throttled by UpdateContinuousBackups, "Rate exceeded").
 * On when BCAT_ENABLE_PITR=true, or (unless BCAT_ENABLE_PITR=false) on the dev stack at the
 * final stage. Production main sets neither, so it never flips PITR.
 */
export function pitrEnabled(env: Readonly<Record<string, string | undefined>>, stage: number): boolean {
  if (env.BCAT_ENABLE_PITR === 'true') return true
  return env.BCAT_ENABLE_PITR !== 'false' && env.BCAT_DEV_STACK === 'true' && stage >= FINAL_STAGE
}

/*
 * STAGE_NOTES: what each stage changes (resources = created + updated + deleted, measured).
 *   0  production shape + additive fields on existing models + new Lambdas/functions   (see doc)
 *   1  models: carriers, ownership, commissions, user profile, integrations, CRM        (see doc)
 *   2  models: shipment core                                                            (see doc)
 *   3  models: billing, Aljex import, workflow, rollups                                 (see doc)
 *   4  TruckLocationHistory TTL, alone                                                  (see doc)
 */

/** The stage this synth builds. Unset, empty or unparsable means "everything". */
export function parseSchemaStage(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return FINAL_STAGE
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${STAGE_ENV}=${JSON.stringify(raw)} is not a non-negative integer`)
  }
  return Math.min(n, FINAL_STAGE)
}

export function currentSchemaStage(): number {
  return parseSchemaStage(process.env[STAGE_ENV])
}

/** True when `model` is part of the schema synthesized at `stage`. */
export function modelPresent(model: string, stage: number): boolean {
  return PRODUCTION_MODELS.has(model) || (MODEL_STAGE[model] ?? LAST_MODEL_STAGE) <= stage
}

/**
 * Scheduled/stream triggers that only make sense once the tables they read exist. The Lambda
 * stays deployed at every stage; only its trigger waits, so nothing fires (and fails on an empty
 * table name) before its stage. A trigger is on at the first stage where ALL its models exist.
 */
export const TRIGGER_MODELS = {
  /** workflow-agent sweep: queries WorkflowRun. */
  workflowSweep: ['WorkflowRun'],
  /** tms-spot-quoter poll: scans GmailConnection, reads SpotSettings/SpotRequest/Integration. */
  spotQuoterPoll: ['SpotRequest', 'SpotSettings', 'GmailConnection', 'Integration'],
  /** mcp-sync: reads/writes Carrier and the Integration pull-state row. */
  mcpSync: ['Carrier', 'Integration'],
  /** tms-data-safety nightly export + check: derive the table suffix from Shipment, record DataExportJob. */
  dataSafetyNightly: ['Shipment', 'DataExportJob'],
  /** tracking-automation Scheduler: POD pass queries Shipment and LoadCheckCall. */
  trackingAutomation: ['Shipment', 'LoadCheckCall'],
} as const satisfies Record<string, readonly string[]>

export type TriggerName = keyof typeof TRIGGER_MODELS

/** True when every table `trigger` needs exists at `stage`. */
export function triggerEnabled(trigger: TriggerName, stage: number): boolean {
  return TRIGGER_MODELS[trigger].every((model) => modelPresent(model, stage))
}

/**
 * The `vendor-ap-extract` Lambda (production's invoice extractor) is kept until this stage, which
 * is the one that creates WorkflowRun; from here workflow-agent (which needs WorkflowRun) takes
 * over and the old Lambda is deleted. Below it vendor-ap-intake keeps invoking vendor-ap-extract
 * exactly as production does today.
 */
export const VENDOR_AP_EXTRACT_RETIRED_STAGE = MODEL_STAGE.WorkflowRun

/** True when vendor-ap-extract still exists and vendor-ap-intake still targets it at `stage`. */
export function vendorApExtractLegacy(stage: number): boolean {
  return stage < VENDOR_AP_EXTRACT_RETIRED_STAGE
}
