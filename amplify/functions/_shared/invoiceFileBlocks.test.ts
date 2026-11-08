import { describe, expect, it } from 'vitest'
import { fileBlockFor, MAX_FILE_BYTES } from './invoiceFileBlocks'

const bytes = Buffer.from('abc')

describe('fileBlockFor', () => {
  it('sends a PDF as a document block, by content type or by extension', () => {
    const want = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'YWJj' } }
    expect(fileBlockFor({ name: 'a.bin', contentType: 'application/pdf', size: 3 }, bytes)).toEqual(want)
    expect(fileBlockFor({ name: 'INV.PDF', contentType: '', size: 3 }, bytes)).toEqual(want)
  })

  it('sends JPEG / PNG / WebP as image blocks and normalises image/jpg', () => {
    expect(fileBlockFor({ name: 'a', contentType: 'image/jpg', size: 3 }, bytes)).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } })
    expect(fileBlockFor({ name: 'a', contentType: 'image/webp', size: 3 }, bytes)).toMatchObject({ type: 'image', source: { media_type: 'image/webp' } })
  })

  it('refuses other types and files over the cap', () => {
    expect(fileBlockFor({ name: 'a.docx', contentType: 'application/msword', size: 3 }, bytes)).toBeNull()
    expect(fileBlockFor({ name: 'a.gif', contentType: 'image/gif', size: 3 }, bytes)).toBeNull()
    expect(fileBlockFor({ name: 'a.pdf', contentType: 'application/pdf', size: MAX_FILE_BYTES + 1 }, bytes)).toBeNull()
  })
})
