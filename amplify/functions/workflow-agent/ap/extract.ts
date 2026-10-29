/**
 * Reading a vendor invoice — moved here verbatim from `vendor-ap-extract`.
 *
 * Two things changed in the move and nothing else:
 *  - the bytes come from `store.getObjectBytes` instead of a second S3 client,
 *  - the e-mail context is wrapped as untrusted content, because an invoice body
 *    is outside text and step K's rule is that it is data, never an instruction.
 *
 * The schema, the caps, the prompt and the fields it fills are unchanged: the AP
 * queue has been reading invoices with these for a while and a reworded prompt
 * would silently change what lands in the amount column.
 */
import { callModel, type FileBlock } from '../model'
import { wrapUntrusted } from '../../../../src/lib/workflows/untrusted'
import { getObjectBytes } from '../store'
import type { Extraction, ExtractableRow } from './merge'

export const MAX_FILES = 3
export const MAX_FILE_BYTES = 8 * 1024 * 1024

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vendor: { type: ['string', 'null'] },
    invoiceNumber: { type: ['string', 'null'] },
    amountDollars: { type: ['number', 'null'] },
    invoiceDate: { type: ['string', 'null'] },
    dueDate: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: ['string', 'null'] },
  },
  required: ['vendor', 'invoiceNumber', 'amountDollars', 'invoiceDate', 'dueDate', 'confidence', 'note'],
} as const

export interface Attachment { key: string; name: string; contentType: string; size: number }

export async function fileBlocks(attachments: Attachment[]): Promise<FileBlock[]> {
  const out: FileBlock[] = []
  for (const a of attachments) {
    if (out.length >= MAX_FILES) break
    const type = (a.contentType || '').toLowerCase()
    const isPdf = type.includes('pdf') || a.name.toLowerCase().endsWith('.pdf')
    const isImage = /^image\/(jpeg|jpg|png|webp)$/.test(type)
    if (!isPdf && !isImage) continue
    if (a.size > MAX_FILE_BYTES) continue
    const bytes = await getObjectBytes(a.key)
    if (!bytes) continue
    const data = bytes.toString('base64')
    out.push(isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: (type === 'image/jpg' ? 'image/jpeg' : type) as 'image/jpeg' | 'image/png' | 'image/webp', data } })
  }
  return out
}

export async function extractFromInvoice(row: ExtractableRow, files: FileBlock[], today: string): Promise<Extraction> {
  const context = [
    `Email subject: ${row.subject ?? ''}`,
    row.fromEmail ? `From: ${row.fromEmail}` : '',
    // Not sliced here: `wrapUntrusted` redacts first and truncates after, so a slice
    // taken beforehand can cut a credential in half and leave both halves under the
    // redactor's length floor. The fence's own 8,000-character cap is the limit.
    row.emailBody ? `Email body (may be truncated):\n${row.emailBody}` : '',
  ].filter(Boolean).join('\n')
  const answer = await callModel<Extraction>(SCHEMA, files, [
    'This is a vendor invoice (or a bill) sent to a trucking company for payment. The attached file is the invoice; the email text is context.',
    wrapUntrusted('EMAIL', context),
    'Extract, for the accounts-payable queue:',
    '- vendor: the company that issued the invoice and is to be paid (not the trucking company being billed).',
    '- invoiceNumber: the invoice number exactly as printed.',
    '- amountDollars: the TOTAL amount due in dollars (after tax, after any credits; the balance due if shown).',
    `- invoiceDate and dueDate as YYYY-MM-DD (today is ${today}). If only payment terms are given (e.g. Net 30), compute dueDate from the invoice date.`,
    '- confidence: how sure you are overall. note: one short sentence on anything a person should check, or null.',
    'If a field is not stated, return null. Never guess an amount.',
  ].join('\n'), 800)
  return answer.value
}
