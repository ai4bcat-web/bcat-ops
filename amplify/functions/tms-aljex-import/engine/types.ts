/**
 * Engine-internal types. The public contract (EngineStore, TableSet, TxItem, AljexImportJob, ...) lives
 * in src/types/tms.ts; this file only adds what the engine passes between its own modules.
 */
import type {
  AljexEntity,
  AljexImportJob,
  EngineRow,
  EngineStore,
  EntityCount,
  TxItem,
} from '../../../../src/types/tms'
import type { CanonicalRow } from '../../../../src/lib/aljex/canonical'
import type { AljexProfile } from '../../../../src/lib/aljex/profile'
import type { MemoAdjustment, MemoOrphan } from '../../../../src/lib/aljex/memos'

export type { EngineRow, EngineStore, TxItem }

/** The actor written on every row the engine creates (createdBy / updatedBy / issuedBy ...). */
export const IMPORT_ACTOR = 'aljex-import'

/** Row classification against what is already on the target (plan §5.8). */
export type ProClass = 'CREATE' | 'ENRICH' | 'LINK' | 'AMBIGUOUS' | 'CONFLICT' | 'OWN'

export interface Finding {
  /** Finding code, e.g. `ZERO_INVOICE`, `JUNK_DATE`. */
  code: string
  pro?: string
  rowNumber?: number
  /** Short non-PII detail (column names, ids, counts). */
  detail?: string
}

export interface MasterCustomer {
  account: string
  /** Canonical name (most frequent; ties: the latest Created Date). */
  name: string
  aliases: string[]
  street: string
  city: string
  state: string
  zip: string
  contact: string
  lastShip: string | null
  /** Lead Source (CRM field); the most recent non-blank value of the account's rows. */
  leadSource: string
  rows: number
}

export interface MasterCarrier {
  id: string
  name: string
  names: string[]
  mc: string
  mcPrefix: string
  dot: string
  scac: string
  safetyRating: string
  phone: string
  email: string
  dispatcher: string
  dispatchPhone: string
  loads: number
  newestShip: string | null
  openBill: boolean
  inFlight: boolean
  costCents: number
  ownAsset: boolean
  caIntrastate: string
  caIntrastateExp: string | null
  txPuc: string
  txPucExp: string | null
}

export interface StagedMemos {
  /** Invoice PRO key -> adjustment lines in file order. */
  byInvoice: Record<string, MemoAdjustment[]>
  orphans: MemoOrphan[]
  appliedCents: number
  orphanCents: number
}

/** Everything the apply phases need that spans rows; computed once by STAGE. */
export interface StagedMasters {
  customers: MasterCustomer[]
  carriers: MasterCarrier[]
  /** CRED/DEBT memos resolved against the file's invoices (DECIDED-1). */
  memos: StagedMemos
  /** Newest plausible Ship Date in the file (anchor of the carrier window). */
  newestShip: string | null
  window: { start: string; end: string }
  /** PRO key -> chunk index of the winning row (identical duplicates collapse to the first). */
  chunkCount: number
  rowsPerChunk: number
}

export interface StageIndex {
  stageHash: string
  layoutId: string
  rows: number
  loads: number
  memos: number
  junkDates: number
  duplicatePros: number
  raggedRows: number
  parseErrors: number
  chunkCount: number
  rowsPerChunk: number
  findings: Finding[]
  /** Staged outcome counts that never reach the apply phases (skips decided at stage time). */
  stagedSkips: Record<string, number>
  /** Step AW history window: the cutoff and window start applied at STAGE (null = no window), and what fell outside. */
  history?: { cutoffDate: string | null; windowStart: string | null; beforeWindow: number; afterCutoff: number }
}

export interface PhaseContext {
  store: EngineStore
  job: AljexImportJob
  rootJobId: string
  profile: AljexProfile
  /** The job being run is a PLAN (overlay store) rather than an APPLY. */
  dryRun: boolean
  /** Hard wall-clock deadline (epoch ms). */
  deadlineMs: number
}

export function emptyCount(): EntityCount {
  return { staged: 0, created: 0, matched: 0, enriched: 0, skipped: 0, conflicts: 0, errors: 0 }
}

export type Counts = Partial<Record<AljexEntity, EntityCount>>

export function bump(counts: Counts, entity: AljexEntity, key: keyof EntityCount, n = 1): void {
  const c = (counts[entity] ??= emptyCount())
  c[key] += n
}

export type Row = CanonicalRow
