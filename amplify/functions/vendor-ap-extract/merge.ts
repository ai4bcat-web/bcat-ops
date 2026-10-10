/**
 * What the extractor is allowed to write: only blanks. A person's own entry always wins,
 * and a low-confidence read of the amount is left for a person to confirm.
 */
export interface Extraction {
  vendor: string | null
  invoiceNumber: string | null
  amountDollars: number | null
  invoiceDate: string | null
  dueDate: string | null
  confidence: 'high' | 'medium' | 'low'
  note: string | null
}

export interface ExtractableRow {
  id: string
  subject?: string | null
  fromEmail?: string | null
  emailBody?: string | null
  vendor?: string | null
  invoiceNumber?: string | null
  amount?: number | null
  invoiceDate?: string | null
  dueDate?: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function mergeExtraction(row: ExtractableRow, x: Extraction): Partial<Pick<ExtractableRow, 'vendor' | 'invoiceNumber' | 'amount' | 'invoiceDate' | 'dueDate'>> {
  const out: Partial<Pick<ExtractableRow, 'vendor' | 'invoiceNumber' | 'amount' | 'invoiceDate' | 'dueDate'>> = {}
  const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim())
  if (blank(row.vendor) && x.vendor?.trim()) out.vendor = x.vendor.trim().slice(0, 255)
  if (blank(row.invoiceNumber) && x.invoiceNumber?.trim()) out.invoiceNumber = x.invoiceNumber.trim().slice(0, 100)
  if (row.amount == null && typeof x.amountDollars === 'number' && Number.isFinite(x.amountDollars) && x.amountDollars > 0 && x.confidence !== 'low') {
    out.amount = Math.round(x.amountDollars * 100)
  }
  if (blank(row.invoiceDate) && x.invoiceDate && DATE.test(x.invoiceDate)) out.invoiceDate = x.invoiceDate
  if (blank(row.dueDate) && x.dueDate && DATE.test(x.dueDate)) out.dueDate = x.dueDate
  return out
}
