/**
 * Invoice bytes → the Anthropic `document` / `image` block the model reads. Lifted from the Step K
 * AP agent (`workflow-agent/ap/extract.ts`) so the AP inbox (Step AG) sends exactly the same
 * blocks: PDF / JPEG / PNG / WebP only, at most `MAX_FILES` files of at most `MAX_FILE_BYTES`.
 */
import type { FileBlock } from '../workflow-agent/model'

export const MAX_FILES = 3
export const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface InvoiceFileSpec {
  name: string
  contentType: string
  size: number
}

/** The block for one file, or null when the type is not readable or the file is too large. */
export function fileBlockFor(file: InvoiceFileSpec, bytes: Buffer): FileBlock | null {
  const type = (file.contentType || '').toLowerCase()
  const isPdf = type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf')
  const isImage = /^image\/(jpeg|jpg|png|webp)$/.test(type)
  if (!isPdf && !isImage) return null
  if (file.size > MAX_FILE_BYTES || bytes.length > MAX_FILE_BYTES) return null
  const data = bytes.toString('base64')
  return isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: (type === 'image/jpg' ? 'image/jpeg' : type) as 'image/jpeg' | 'image/png' | 'image/webp', data } }
}
