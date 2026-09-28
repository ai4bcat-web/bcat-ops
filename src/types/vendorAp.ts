export type VendorPayableStatus = 'NEED_TO_PAY' | 'DONE'
export type VendorPayableSource = 'MAINTENANCE' | 'EMAIL'

export interface VendorApAttachment {
  key: string
  name: string
  contentType: string
  size: number
}

export interface VendorPayable {
  id: string
  status: VendorPayableStatus
  source: VendorPayableSource
  sourceInvoiceId?: string | null
  sourceMessageId?: string | null
  subject: string
  vendor?: string | null
  invoiceNumber?: string | null
  amount?: number | null // cents; unknown for unreviewed email invoices
  invoiceDate?: string | null
  description?: string | null
  fromEmail?: string | null
  emailBody?: string | null
  attachments: VendorApAttachment[]
  receivedAt: string
  paymentMethod?: string | null
  paymentDate?: string | null
  paymentReference?: string | null
  paidBy?: string | null
  paidAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface VendorPayableDetails {
  vendor?: string | null
  invoiceNumber?: string | null
  amount?: number | null
  invoiceDate?: string | null
  description?: string | null
}

export interface VendorPayment {
  paymentMethod: string
  paymentDate: string
  paymentReference?: string | null
}
