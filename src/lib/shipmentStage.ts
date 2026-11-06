/**
 * The ONE place a shipment's lifecycle stage is derived (summary rail Activity block).
 *
 * It composes the vocabularies that already exist rather than inventing a new one: the Shipments
 * board's status (`boardStatusOf`: Open / Reserved / Covered / Dispatched / Departed / Arrived /
 * Delivered / Hold / Voided), Load Review's released-to-billing rule (`isReleasedToInvoicing`) and
 * the order's AR status (`ArStatus`). The result is a position on the nine-step ladder
 * Draft → Intake review → Active → Covered → In transit → Delivered → Load Review → Billed → Paid,
 * with Voided (and a plain Canceled) as red terminal states off the ladder.
 *
 * Pure: inputs in, stage out. Relative imports only (this file may be bundled by a Lambda).
 */
import type { ArStatus, AssignmentType, ShipmentBundle, ShipmentStatus } from '../types/tms'
import { boardStatusOf } from './shipmentViewDefs'
import { isReleasedToInvoicing } from './shipmentLists'

export type LadderStage =
  | 'DRAFT' | 'INTAKE_REVIEW' | 'ACTIVE' | 'COVERED' | 'IN_TRANSIT' | 'DELIVERED' | 'LOAD_REVIEW' | 'BILLED' | 'PAID'
export type TerminalStage = 'VOIDED' | 'CANCELED'
export type ShipmentStage = LadderStage | TerminalStage

/** The ladder, left to right. */
export const STAGE_LADDER: readonly LadderStage[] = [
  'DRAFT', 'INTAKE_REVIEW', 'ACTIVE', 'COVERED', 'IN_TRANSIT', 'DELIVERED', 'LOAD_REVIEW', 'BILLED', 'PAID',
]

export const STAGE_LABEL: Record<ShipmentStage, string> = {
  DRAFT: 'Draft',
  INTAKE_REVIEW: 'Intake review',
  ACTIVE: 'Active',
  COVERED: 'Covered',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  LOAD_REVIEW: 'Load Review',
  BILLED: 'Billed',
  PAID: 'Paid',
  VOIDED: 'Voided',
  CANCELED: 'Canceled',
}

/** What the mapper reads: shipment + the first order's AR fields + the load's assignment type. */
export interface StageInput {
  status: ShipmentStatus
  voidedAt?: string | null
  deletedAt?: string | null
  deliveredAt?: string | null
  legacyImported?: boolean | null
  /** Intake item this shipment came from; with no `intakeReviewedAt` a DRAFT is still in Intake review. */
  intakeLoadId?: string | null
  intakeReviewedAt?: string | null
  loadReviewPushedAt?: string | null
  assignmentType?: AssignmentType | null
  arStatus?: ArStatus | null
  readyToInvoiceAt?: string | null
  invoiceId?: string | null
}

export interface StageResult {
  stage: ShipmentStage
  label: string
  /** Index on the ladder; -1 for the terminal states. */
  step: number
  /** Create mode: the shipment row does not exist yet. */
  notCreated: boolean
  terminal: boolean
}

const result = (stage: ShipmentStage, notCreated = false): StageResult => ({
  stage,
  label: notCreated ? 'Draft, not created yet' : STAGE_LABEL[stage],
  step: STAGE_LADDER.indexOf(stage as LadderStage),
  notCreated,
  terminal: stage === 'VOIDED' || stage === 'CANCELED',
})

/** Create mode (no row yet): Draft, stepper at Draft. */
export function notCreatedStage(): StageResult {
  return result('DRAFT', true)
}

export function shipmentStage(row: StageInput): StageResult {
  const board = boardStatusOf(row)
  if (board === 'VOIDED') return result('VOIDED')
  if (board === 'CANCELED') return result('CANCELED')

  // Money states win once the order is in accounting's hands.
  if (row.arStatus === 'PAID') return result('PAID')
  if (row.arStatus === 'UNPAID' || row.arStatus === 'INVOICE_NOT_NEEDED' || row.arStatus === 'LEGACY' || row.invoiceId) return result('BILLED')
  // Released to billing but not invoiced yet, or pushed into the Load Review queue from the board.
  if (row.loadReviewPushedAt || isReleasedToInvoicing(row)) return result('LOAD_REVIEW')

  if (row.status === 'DRAFT') return result(row.intakeLoadId && !row.intakeReviewedAt ? 'INTAKE_REVIEW' : 'DRAFT')
  switch (board) {
    case 'DELIVERED': return result('DELIVERED')
    case 'DISPATCHED':
    case 'DEPARTED':
    case 'ARRIVED': return result('IN_TRANSIT')
    case 'COVERED':
    case 'RESERVED': return result('COVERED')
    default: return result('ACTIVE')
  }
}

/** The stage of a loaded bundle (the shipment, its first order's AR fields, its first load's assignment); no bundle = create mode. */
export function stageOfBundle(bundle: Pick<ShipmentBundle, 'shipment' | 'orders' | 'loads'> | null): StageResult {
  if (!bundle) return notCreatedStage()
  const { shipment, orders, loads } = bundle
  const order = orders[0]
  return shipmentStage({
    ...shipment,
    arStatus: order?.arStatus,
    readyToInvoiceAt: order?.readyToInvoiceAt,
    invoiceId: order?.invoiceId,
    assignmentType: loads[0]?.assignmentType,
  })
}
