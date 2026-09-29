export type PodProcessingStatus = 'PENDING' | 'READY' | 'ORIGINAL_ONLY' | 'FAILED'

/** One JobsDone attachment; originals and scan-cleaned derivatives are retained separately. */
export interface PodDocument {
  id: string
  clientId: string
  sourceMessageId: string
  mediaIndex: number
  companyName: string
  senderName: string
  senderContact: string
  receivedAt: string
  referenceNumber: string
  notes: string
  isAllowed: boolean
  fileName: string
  contentType?: string | null
  originalKey?: string | null
  enhancedKey?: string | null
  processingStatus: PodProcessingStatus
  processingError?: string | null
  processingVersion?: number | null
  scanReviewReason?: string | null
  loadId?: string | null
  assignedBy?: string | null
  assignedAt?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface PodConnectionStatus {
  configured: boolean
  clientId?: string
  companyName?: string
  backgroundSyncEnabled?: boolean
}

export interface PodPage {
  items: PodDocument[]
  nextToken: string | null
}

export interface PodSyncResult {
  imported: number
  /** Feed rows that could not be understood or belonged to another tenant; never stored. */
  skipped: number
  nextToken: string | null
}

export interface PodAssets {
  item: PodDocument
  originalUrl?: string
  enhancedUrl?: string
}
