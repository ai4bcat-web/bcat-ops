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
  /** From the invoice: when payment is due. */
  dueDate?: string | null
  /** Where the payment confirmation goes; blank means the email's sender. */
  vendorEmail?: string | null
  confirmationSentAt?: string | null
  confirmationSentTo?: string | null
  extractedAt?: string | null
  extractionNote?: string | null
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
  dueDate?: string | null
  vendorEmail?: string | null
  description?: string | null
}

export type VendorPaymentMethod = 'ACH' | 'Check' | 'Credit card'
export const VENDOR_PAYMENT_METHODS: VendorPaymentMethod[] = ['ACH', 'Check', 'Credit card']

export interface VendorPayment {
  paymentMethod: VendorPaymentMethod | string
  /** Defaults to today in Chicago when omitted; the server stamps paidAt with the exact time. */
  paymentDate?: string
  paymentReference?: string | null
  /** Email the vendor a confirmation (when an address is on file). Default true. */
  notifyVendor?: boolean
}
