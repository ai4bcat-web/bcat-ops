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
  /*
   * The same objects, signed to arrive as a download rather than to be rendered.
   *
   * Reading the bytes with fetch and re-wrapping them is the nicer path — it is what turns
   * an enhanced JPEG into the PDF a broker expects — but it is also the fragile one: a
   * cross-origin fetch is what an extension, a proxy or a captive network blocks, and all
   * the browser says is "Failed to fetch". These URLs carry a Content-Disposition, so an
   * ordinary link saves the file with no script involved at all.
   */
  originalDownloadUrl?: string
  enhancedDownloadUrl?: string
}

export interface PodSenderMapping {
  clientId: string
  senderKey: string // phone:<10 digits> or name:<normalized tokens>
  senderName: string
  driverId: string
  updatedBy: string
  updatedAt: string
}
