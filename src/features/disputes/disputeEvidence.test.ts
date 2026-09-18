import { describe, it, expect } from 'vitest'
import {
  driverEvidence, isBrowserRenderable, mergeDisputeEvidence, responseEvidence, responseFileRejection,
} from './disputeEvidence'
import type { DisputeEvidence } from '@/types/dispute'

/**
 * A staff save rewrites the WHOLE evidence array. The driver's confirmation and photos are
 * the only proof tying the claim to the trip, staff have no write grant on dispute-proofs/,
 * and a portal row can't be re-filed — so dropping them here is unrecoverable data loss.
 */
const confirmation: DisputeEvidence = {
  s3Key: 'dispute-proofs/sub-1/a.pdf', fileName: 'confirmation.pdf', contentType: 'application/pdf', size: 2048, kind: 'CONFIRMATION',
}
const photo: DisputeEvidence = {
  s3Key: 'dispute-proofs/sub-1/b.jpg', fileName: 'trailer.jpg', contentType: 'image/jpeg', size: 4096, kind: 'PHOTO',
}
const reply: DisputeEvidence = {
  s3Key: 'dispute-responses/d-1/1-amazon.png', fileName: 'amazon.png', contentType: 'image/png', size: 1024, kind: 'AMAZON_RESPONSE',
}

describe('dispute evidence split', () => {
  it('keeps the driver upload when staff attach a reply', () => {
    const merged = mergeDisputeEvidence([confirmation, photo], [reply])
    expect(merged).toEqual([confirmation, photo, reply])
  })

  it('keeps the driver upload when staff remove every reply', () => {
    expect(mergeDisputeEvidence([confirmation, photo, reply], [])).toEqual([confirmation, photo])
  })

  it('replaces the previous reply instead of stacking duplicates', () => {
    const newer: DisputeEvidence = { ...reply, s3Key: 'dispute-responses/d-1/2-amazon.png' }
    expect(mergeDisputeEvidence([confirmation, reply], [newer])).toEqual([confirmation, newer])
  })

  it('treats a row with no evidence yet as empty, not a crash', () => {
    expect(mergeDisputeEvidence(null, [reply])).toEqual([reply])
    expect(driverEvidence(undefined)).toEqual([])
    expect(responseEvidence(null)).toEqual([])
  })

  it('separates driver files from staff replies', () => {
    const all = [confirmation, reply, photo]
    expect(driverEvidence(all)).toEqual([confirmation, photo])
    expect(responseEvidence(all)).toEqual([reply])
  })
})

describe('thumbnail rendering', () => {
  it('renders ordinary images and skips PDFs and iPhone HEIC', () => {
    expect(isBrowserRenderable(photo)).toBe(true)
    expect(isBrowserRenderable(confirmation)).toBe(false)
    expect(isBrowserRenderable({ ...photo, contentType: 'image/heic', s3Key: 'dispute-proofs/s/c.heic' })).toBe(false)
  })

  it('falls back to the key extension when the stored contentType is useless', () => {
    expect(isBrowserRenderable({ ...photo, contentType: 'application/octet-stream', s3Key: 'dispute-proofs/s/d.png' })).toBe(true)
  })
})

describe('staff upload validation', () => {
  it('accepts screenshots and PDFs of the Amazon reply', () => {
    expect(responseFileRejection({ name: 'a.png', type: 'image/png', size: 1024 })).toBeNull()
    expect(responseFileRejection({ name: 'a.pdf', type: 'application/pdf', size: 1024 })).toBeNull()
    expect(responseFileRejection({ name: 'a.heic', type: 'image/heic', size: 1024 })).toBeNull()
  })

  it('falls back to the extension when the browser reports no type (HEIC, dragged files)', () => {
    expect(responseFileRejection({ name: 'IMG_0421.HEIC', type: '', size: 1024 })).toBeNull()
    expect(responseFileRejection({ name: 'reply.pdf', type: '', size: 1024 })).toBeNull()
    expect(responseFileRejection({ name: 'notes.txt', type: '', size: 1024 })).toMatch(/screenshot/i)
    expect(responseFileRejection({ type: '', size: 1024 })).toMatch(/screenshot/i)
  })

  it('rejects scriptable SVG, foreign file types, empty and oversize files', () => {
    expect(responseFileRejection({ name: 'x.svg', type: 'image/svg+xml', size: 1024 })).toMatch(/screenshot/i)
    expect(responseFileRejection({ name: 'x.csv', type: 'text/csv', size: 1024 })).toMatch(/screenshot/i)
    expect(responseFileRejection({ name: 'x.png', type: 'image/png', size: 0 })).toMatch(/empty/i)
    expect(responseFileRejection({ name: 'x.png', type: 'image/png', size: 11 * 1024 * 1024 })).toMatch(/10 MB/)
  })
})
