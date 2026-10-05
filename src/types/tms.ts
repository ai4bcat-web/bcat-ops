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
  createdAt: string
  updatedAt: string
}

export interface LocationContact {
  name?: string | null
  role?: string | null
  email?: string | null
  phone?: string | null
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
