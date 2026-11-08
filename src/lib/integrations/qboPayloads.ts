/**
 * Step J — QuickBooks Online payload builders.
 *
 * Pure: these functions build the JSON Intuit's API would receive and return it.
 * Nothing here sends anything — `PREVIEW_QBO_SYNC` shows the payload and stops
 * (J ships connect + validate + mappings + preview; the push waits for K's Errors
 * tab, which is what makes a failed sync honest).
 *
 * Money is integer cents everywhere in this repo and QBO wants decimal strings.
 * The conversion goes through `centsToDecimal` and is done with integer
 * arithmetic: `cents / 100` in floating point turns 1_00 into 0.9999999999999999
 * often enough to matter on a 200-line invoice, and a rounded total that does not
 * equal the sum of its rounded lines is an invoice QBO refuses.
 */

/** One invoice line as the AR ledger stores it. */
export interface QboInvoiceLineInput {
  code?: string | null
  label?: string | null
  amountCents: number
  count?: number | null
  rateCents?: number | null
}

export interface QboInvoiceInput {
  number: string
  invoiceDate: string
  dueAt: string
  customerId: string
  customerName?: string | null
  termsText?: string | null
  lines?: QboInvoiceLineInput[] | null
  totalCents: number
}

export interface QboCustomerInput {
  id: string
  name: string
  billingEmail?: string | null
  phone?: string | null
  billingAddress?: {
    street?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    country?: string | null
  } | null
}

export interface QboPaymentAllocation {
  invoiceId: string
  amountCents: number
}

export interface QboPaymentInput {
  id: string
  customerId: string
  receivedAt: string
  method?: string | null
  reference?: string | null
  amountCents: number
}

export interface QboBillLineInput {
  code?: string | null
  label?: string | null
  amountCents: number
}

export interface QboBillInput {
  id: string
  carrierId: string
  carrierName?: string | null
  billNumber?: string | null
  billDate: string
  dueAt: string
  lines?: QboBillLineInput[] | null
  netCents: number
}

/** What an admin maps on the QuickBooks page. Every value is a QBO entity id. */
export interface QboMappings {
  /** QBO Account id for accounts receivable. */
  arAccountRef?: string | null
  /** QBO Account id for accounts payable. */
  apAccountRef?: string | null
  /** Where a customer payment is deposited. */
  depositAccountRef?: string | null
  /** The expense account a carrier bill line without its own mapping lands in. */
  expenseAccountRef?: string | null
  /** chargeCode → QBO product/service item id. */
  chargeCodeItems?: Record<string, string> | null
  /** BCAT customer id → QBO customer id. */
  customerRefs?: Record<string, string> | null
  /** BCAT carrier id → QBO vendor id. */
  vendorRefs?: Record<string, string> | null
}

/** The shapes below mirror Intuit's request bodies; only the fields BCAT sends. */
export interface QboRef {
  value: string
  name?: string
}

export interface QboLine {
  Description: string
  Amount: string
  DetailType: 'SalesItemLineDetail' | 'AccountBasedExpenseLineDetail'
  SalesItemLineDetail?: { ItemRef: QboRef; Qty?: number; UnitPrice?: string }
  AccountBasedExpenseLineDetail?: { AccountRef: QboRef }
}

export interface QboInvoicePayload {
  DocNumber: string
  TxnDate: string
  DueDate: string
  CustomerRef: QboRef
  Line: QboLine[]
  TotalAmt: string
  CustomerMemo?: { value: string }
}

export interface QboCustomerPayload {
  DisplayName: string
  CompanyName: string
  PrimaryEmailAddr?: { Address: string }
  PrimaryPhone?: { FreeFormNumber: string }
  BillAddr?: {
    Line1?: string
    City?: string
    CountrySubDivisionCode?: string
    PostalCode?: string
    Country?: string
  }
}

export interface QboPaymentPayload {
  CustomerRef: QboRef
  TxnDate: string
  TotalAmt: string
  PaymentRefNum?: string
  DepositToAccountRef?: QboRef
  Line: Array<{ Amount: string; LinkedTxn: Array<{ TxnId: string; TxnType: 'Invoice' }> }>
}

export interface QboBillPayload {
  VendorRef: QboRef
  DocNumber?: string
  TxnDate: string
  DueDate: string
  APAccountRef?: QboRef
  Line: QboLine[]
  TotalAmt: string
}

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER

/**
 * Integer cents → the decimal string QBO expects, exactly.
 *
 * Integer division and remainder only: no `/ 100`, no `toFixed`, no float ever
 * touches the value. `-5` becomes `"-0.05"`, `0` becomes `"0.00"`.
 */
export function centsToDecimal(cents: number): string {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) {
    throw new Error(`centsToDecimal expects integer cents, got ${String(cents)}`)
  }
  if (Math.abs(cents) > MAX_SAFE_CENTS) {
    throw new Error('centsToDecimal: amount exceeds the safe integer range')
  }
  const negative = cents < 0
  const abs = negative ? -cents : cents
  const whole = Math.trunc(abs / 100)
  const fraction = abs - whole * 100
  const fractionText = fraction < 10 ? `0${fraction}` : String(fraction)
  return `${negative ? '-' : ''}${whole}.${fractionText}`
}

function refOf(map: Record<string, string> | null | undefined, key: string): string | null {
  if (!map) return null
  const value = map[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function lineDescription(code: string | null | undefined, label: string | null | undefined): string {
  const text = (label ?? '').trim() || (code ?? '').trim()
  return text || 'Freight'
}

/**
 * The invoice as QBO would receive it.
 *
 * `TotalAmt` is `invoice.totalCents` converted once, not a sum of the converted
 * lines: the ledger's total is the authority and a preview that quietly disagreed
 * with the invoice that was sent would be worse than no preview.
 */
export function qboInvoiceFor(invoice: QboInvoiceInput, mappings?: QboMappings | null): QboInvoicePayload {
  const customerRef = refOf(mappings?.customerRefs, invoice.customerId)
  const lines = invoice.lines ?? []
  const payload: QboInvoicePayload = {
    DocNumber: invoice.number,
    TxnDate: invoice.invoiceDate,
    DueDate: invoice.dueAt,
    CustomerRef: customerRef
      ? { value: customerRef, name: invoice.customerName ?? undefined }
      : { value: '', name: invoice.customerName ?? undefined },
    Line: lines.map((line) => {
      const itemRef = refOf(mappings?.chargeCodeItems, (line.code ?? '').trim())
      const detail: QboLine = {
        Description: lineDescription(line.code, line.label),
        Amount: centsToDecimal(line.amountCents),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: { ItemRef: { value: itemRef ?? '' } },
      }
      if (typeof line.count === 'number' && Number.isFinite(line.count)) {
        detail.SalesItemLineDetail = {
          ...(detail.SalesItemLineDetail as { ItemRef: QboRef }),
          Qty: line.count,
        }
      }
      if (typeof line.rateCents === 'number' && Number.isInteger(line.rateCents)) {
        detail.SalesItemLineDetail = {
          ...(detail.SalesItemLineDetail as { ItemRef: QboRef }),
          UnitPrice: centsToDecimal(line.rateCents),
        }
      }
      return detail
    }),
    TotalAmt: centsToDecimal(invoice.totalCents),
  }
  const memo = (invoice.termsText ?? '').trim()
  if (memo) payload.CustomerMemo = { value: memo }
  return payload
}

export function qboCustomerFor(customer: QboCustomerInput): QboCustomerPayload {
  const payload: QboCustomerPayload = {
    DisplayName: customer.name,
    CompanyName: customer.name,
  }
  const email = (customer.billingEmail ?? '').trim()
  if (email) payload.PrimaryEmailAddr = { Address: email }
  const phone = (customer.phone ?? '').trim()
  if (phone) payload.PrimaryPhone = { FreeFormNumber: phone }
  const addr = customer.billingAddress
  if (addr) {
    const billAddr: NonNullable<QboCustomerPayload['BillAddr']> = {}
    if (addr.street?.trim()) billAddr.Line1 = addr.street.trim()
    if (addr.city?.trim()) billAddr.City = addr.city.trim()
    if (addr.state?.trim()) billAddr.CountrySubDivisionCode = addr.state.trim()
    if (addr.zip?.trim()) billAddr.PostalCode = addr.zip.trim()
    if (addr.country?.trim()) billAddr.Country = addr.country.trim()
    if (Object.keys(billAddr).length > 0) payload.BillAddr = billAddr
  }
  return payload
}

export function qboPaymentFor(
  payment: QboPaymentInput,
  allocations: QboPaymentAllocation[],
  mappings?: QboMappings | null,
): QboPaymentPayload {
  const customerRef = refOf(mappings?.customerRefs, payment.customerId)
  const depositRef = (mappings?.depositAccountRef ?? '').trim()
  const payload: QboPaymentPayload = {
    CustomerRef: { value: customerRef ?? '' },
    TxnDate: payment.receivedAt.slice(0, 10),
    TotalAmt: centsToDecimal(payment.amountCents),
    Line: allocations.map((allocation) => ({
      Amount: centsToDecimal(allocation.amountCents),
      LinkedTxn: [{ TxnId: allocation.invoiceId, TxnType: 'Invoice' as const }],
    })),
  }
  const reference = (payment.reference ?? '').trim()
  if (reference) payload.PaymentRefNum = reference
  if (depositRef) payload.DepositToAccountRef = { value: depositRef }
  return payload
}

export function qboBillFor(bill: QboBillInput, mappings?: QboMappings | null): QboBillPayload {
  const vendorRef = refOf(mappings?.vendorRefs, bill.carrierId)
  const apRef = (mappings?.apAccountRef ?? '').trim()
  const expenseRef = (mappings?.expenseAccountRef ?? '').trim()
  const lines = bill.lines ?? []
  const payload: QboBillPayload = {
    VendorRef: vendorRef
      ? { value: vendorRef, name: bill.carrierName ?? undefined }
      : { value: '', name: bill.carrierName ?? undefined },
    TxnDate: bill.billDate,
    DueDate: bill.dueAt,
    Line: lines.map((line) => ({
      Description: lineDescription(line.code, line.label),
      Amount: centsToDecimal(line.amountCents),
      DetailType: 'AccountBasedExpenseLineDetail' as const,
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseRef } },
    })),
    TotalAmt: centsToDecimal(bill.netCents),
  }
  const billNumber = (bill.billNumber ?? '').trim()
  if (billNumber) payload.DocNumber = billNumber
  if (apRef) payload.APAccountRef = { value: apRef }
  return payload
}

/**
 * Every charge code that is actually used must map to a QBO item before a sync
 * could run. A mapping that is merely incomplete for codes nobody bills is fine —
 * the check is over the codes in play, not over the whole code list.
 */
export function qboMappingsValid(
  mappings: QboMappings | null | undefined,
  chargeCodes: string[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const items = mappings?.chargeCodeItems ?? null
  const seen = new Set<string>()
  for (const raw of chargeCodes) {
    const code = (raw ?? '').trim()
    if (!code || seen.has(code)) continue
    seen.add(code)
    if (!refOf(items, code)) errors.push(`Charge code ${code} has no QuickBooks item mapping`)
  }
  if (!(mappings?.arAccountRef ?? '').trim()) {
    errors.push('No accounts-receivable account is mapped')
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
