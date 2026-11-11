/**
 * Step U — Intake. A tender e-mail that arrived at a division's intake address becomes an
 * `IntakeLoad`: a partially built load a person reviews before it becomes an Active shipment.
 * Wire shapes shared by the workflow-agent stager, the tms-shipment-actions promote action,
 * the pure `src/lib/intake.ts` and the Intake pages.
 */

export type IntakeStatus = 'OPEN' | 'PROMOTING' | 'MOVED' | 'DISMISSED'
export type IntakeParseState = 'PARSED' | 'NOT_PARSED' | 'FAILED'
export type IntakeSource = 'PARSER' | 'MODEL' | 'RATECON' | 'DIRECTORY' | 'ADDRESS' | 'DEFAULT' | 'REVIEWER'
export type IntakeConfidence = 'high' | 'low'
export interface IntakeFieldMeta { source: IntakeSource; confidence: IntakeConfidence }
export type IntakeFieldStatus = 'AUTO' | 'LOW' | 'MISSING' | 'CONFIRMED' | 'INVALID'

export interface IntakeStop {
  type: 'pickup' | 'delivery'
  name: string | null; street: string | null
  city: string | null; state: string | null; zip: string | null
  date: string | null          // YYYY-MM-DD
  time: string | null          // HH:mm
  instructions: string | null
}

export interface IntakeFields {
  customerId: string | null;  customerName: string | null          // customerName = typed/parsed text when unresolved
  billToId: string | null;    salesRepId: string | null;  divisionCode: string | null
  reference: string | null;   pickupNumber: string | null;  deliveryNumber: string | null
  equipmentType: string | null; commodity: string | null
  /** A key from `SHIPMENT_TYPES` (`src/lib/shipmentTypes.ts`); null when the e-mail does not say. */
  shipmentType: string | null
  weightLb: number | null;    customerRateCents: number | null
  /** An own-fleet (Ivan Cartage) roster driver to book on the load when it is created. Optional; absent on older rows. */
  driverId?: string | null
  stops: IntakeStop[]
}

/** meta keys: scalar field names above, and `stops.<i>.<key>` for stop fields. */
export type IntakeMeta = Record<string, IntakeFieldMeta>

export interface IntakeAttachment { name: string; contentType: string; size: number; key: string }
export interface IntakeCustomerCandidate { id: string; name: string; how: string }

export interface IntakeLoadRecord {
  id: string; status: IntakeStatus
  divisionCode: string | null; toAddress: string | null; toAddresses: string[]
  runId: string; sourceKey: string | null
  subject: string; fromEmail: string; fromName: string; receivedAt: string; bodyText: string
  attachments: IntakeAttachment[]
  parseState: IntakeParseState; parseNote: string | null; format: string | null
  fields: IntakeFields; autoFields: IntakeFields & { customerCandidates?: IntakeCustomerCandidate[] }
  meta: IntakeMeta; confirmed: string[]; missingFields: string[]
  /** Repeat e-mails for the same load roll up here instead of becoming new rows. */
  emailLog?: { at: string; subject: string; runId: string }[] | null
  shipmentId: string | null; shipmentNumber: string | null
  reviewedBy: string | null; reviewedAt: string | null
  lastEditedBy: string | null; lastEditedAt: string | null
  dismissedBy: string | null; dismissedAt: string | null; dismissReason: string | null
  createdBy: string; updatedBy: string; version: number; createdAt: string; updatedAt: string
}
