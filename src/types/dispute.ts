// Amazon driver dispute — a claim that Amazon underpaid / owes on a trip.
// Rows come from the driver portal (source DRIVER_PORTAL), a Google Form
// (source GOOGLE_FORM, via the amazon-dispute-intake Lambda), or are added by
// hand in the app (source MANUAL).

export type DisputeStatus = 'PENDING' | 'POSTED' | 'PAID' | 'REJECTED'
export type DisputeSource = 'GOOGLE_FORM' | 'MANUAL' | 'DRIVER_PORTAL'
// CONFIRMATION/PHOTO come from the driver portal; AMAZON_RESPONSE is a staff upload of
// what Amazon replied (screenshot or PDF), stored under dispute-responses/{disputeId}/.
export type DisputeEvidenceKind = 'CONFIRMATION' | 'PHOTO' | 'AMAZON_RESPONSE'

export interface DisputeEvidence {
  s3Key: string
  fileName: string
  contentType: string
  size: number
  kind: DisputeEvidenceKind
}

export interface AmazonDispute {
  id: string
  driverName: string
  tripNumber?: string | null
  shipmentDate?: string | null      // YYYY-MM-DD or raw form value
  payPeriod?: string | null         // "4/19 - 4/25" or YYYY-MM-DD Sunday START
  amountPaid?: number | null        // dollars paid by Amazon
  amountRequested?: number | null   // dollars requested from Amazon
  description?: string | null
  photoUrl?: string | null          // legacy Google Drive proof link
  evidence?: DisputeEvidence[] | null // portal-uploaded proof + staff response screenshots (AWSJSON)
  status?: DisputeStatus | null
  resolvedAmount?: number | null    // dollars actually recovered when PAID
  submittedAt?: string | null       // ISO — form timestamp
  source?: DisputeSource | null
  externalId?: string | null
  notes?: string | null
  amazonResponse?: string | null    // what Amazon replied, recorded by staff
  amazonResponseAt?: string | null  // ISO — when the response was recorded
  amazonResponseBy?: string | null  // staff email that recorded it
  // Set when a PAID dispute has been posted onto a driver's weekly settlement as a
  // DISPUTE shipment row.
  settlementPeriodStart?: string | null  // YYYY-MM-DD Sunday of the settlement week
  settlementTripId?: string | null       // the AmazonTrip row it created
  settlementDriverId?: string | null     // the driver whose check carries it
  createdAt: string
  updatedAt: string
}
