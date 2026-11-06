/**
 * The section contract (AH-plan §3.3). Sections code against `SectionProps<K>` and read
 * everything shared from `FormCtx`; they never import each other.
 */
import type {
  CarrierRecord, CustomerRecord, LocationRecord, OwnershipDivisionRecord, ShipmentBundle, ShipmentDocumentType, ShipmentStatus,
  TmsSettings, UserProfileRecord,
} from '@/types/tms'
import type { LockSet, ShipmentFormValues } from './model'

// Structural copy of taxonomyDrafts.DivisionTreeRow: that module pulls UI-only imports ('@/lib/apiClient') into the Lambda typecheck, because amplify/ bundles this form model.
type DivisionTreeRow = { division: OwnershipDivisionRecord; depth: number }

export type SectionKey =
  | 'shipping' | 'customer' | 'pickup' | 'consignee' | 'history' | 'roles'
  | 'more' | 'rates' | 'carrier' | 'picks' | 'documents' | 'checkCalls'

/** One problem with the form. `fieldKey` is the `data-testid` of the control to focus. */
export interface FormIssue {
  /** Stable: `<section>:<field>[:<stopIndex>]`. */
  id: string
  section: SectionKey
  fieldKey: string
  /** The Aljex label, so the strip can say "Equipment, Weight, Description". */
  label: string
  message: string
  /** `error` blocks the action it was computed for; `warn` never blocks. */
  severity: 'error' | 'warn'
}

/** What a section's Add Check Call row hands back. */
export interface CheckCallDraft {
  city: string
  state: string
  at: string
  temperature: string
  note: string
  message: string
  ediReason: string
  nextAt: string
  nextNote: string
}

/** Post-save actions. Immediate (own buttons); none is part of Save changes. All are no-ops while `ctx.busy`. */
export interface FormActions {
  /** Opens BookCarrierDialog prefilled from the form (own fleet: AssignDriverDialog). */
  cover(): void
  openDispatch(): void
  openSendRateCon(): void
  openSendInfo(): void
  /** Opens the existing RemoveCarrierDialog with outcome TONU. */
  openTonu(): void
  sendSetupPacket(carrierId: string, email: string): Promise<void>
  addCheckCall(draft: CheckCallDraft): Promise<void>
  uploadDocument(file: File, audience: 'ALL' | 'INTERNAL', type: ShipmentDocumentType): Promise<void>
  /** Create mode: hold the file until after the first save. */
  queueDocument(file: File, audience: 'ALL' | 'INTERNAL', type: ShipmentDocumentType): void
  unqueueDocument(index: number): void
}

export interface FormCtx {
  mode: 'create' | 'edit'
  /** Null until the first server save. */
  bundle: ShipmentBundle | null
  shipmentStatus: ShipmentStatus | 'NEW'
  locked: LockSet
  directory: {
    customers: CustomerRecord[]
    locations: LocationRecord[]
    /** Starts the one-time read of the locations table; the form does not read it on mount. */
    ensureLocations?: () => void
    carriers: CarrierRecord[]
    staff: UserProfileRecord[]
  }
  settings: TmsSettings | null
  /** Resolved from `values.customer.id`. */
  customer: CustomerRecord | null
  divisions: DivisionTreeRow[]
  /** A pipeline is running: every input is disabled. */
  busy: boolean
  actions: FormActions
  /** Re-read the shipment bundle from the server (after a write made outside the form's own pipelines, e.g. tracking mode). */
  refreshBundle: () => Promise<void>
  /** All current issues; a section filters by `section`. */
  issues: FormIssue[]
}

export interface SectionProps<K extends keyof ShipmentFormValues> {
  value: ShipmentFormValues[K]
  onChange: (patch: Partial<ShipmentFormValues[K]> | ((prev: ShipmentFormValues[K]) => ShipmentFormValues[K])) => void
  ctx: FormCtx
}
