import { describe, expect, it } from 'vitest'
import type { GmailMessageMeta } from '../spot/port'
import { pickInvoiceAttachments, prefilterApStage1, prefilterApStage2 } from './prefilter'

const meta = (over: Partial<GmailMessageMeta> = {}): GmailMessageMeta => ({
  id: 'm', threadId: 't', internalDate: '1', from: 'Billing <billing@swift.test>', to: [], cc: [], replyTo: null, subject: 'Invoice 55', messageId: '<m>', inReplyTo: null,
  references: null, snippet: '', labelIds: ['INBOX'], headers: {}, ...over,
})
const ctx = { ignoreSenders: ['spam.test'] }

describe('stage 1', () => {
  it('passes an own-domain forward (the invoice sits in the quoted part)', () => {
    expect(prefilterApStage1(meta({ from: 'Ryne <ryne@bcat.test>', subject: 'Fwd: Invoice 55' }), ctx).pass).toBe(true)
  })
  it('rejects sent / draft, bounces, ignored senders', () => {
    expect(prefilterApStage1(meta({ labelIds: ['SENT'] }), ctx).pass).toBe(false)
    expect(prefilterApStage1(meta({ from: 'mailer-daemon@x.test' }), ctx).pass).toBe(false)
    expect(prefilterApStage1(meta({ from: 'a@spam.test' }), ctx)).toMatchObject({ pass: false, reason: 'IGNORED_SENDER' })
  })
  it('rejects promotions unless the subject or snippet carries an invoice token', () => {
    expect(prefilterApStage1(meta({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], subject: '20% off', snippet: 'sale' }), ctx).pass).toBe(false)
    expect(prefilterApStage1(meta({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], subject: 'Your invoice is ready' }), ctx).pass).toBe(true)
  })
})

describe('stage 2', () => {
  it('a PDF >= 8 KB passes; a tiny scanned invoice attachment is judged by the text instead', () => {
    expect(prefilterApStage2('see attached', [{ name: 'a.pdf', contentType: 'application/pdf', size: 20_000 }]).pass).toBe(true)
    expect(prefilterApStage2('see attached', [{ name: 'a.pdf', contentType: 'application/pdf', size: 900 }]).pass).toBe(false)
    expect(prefilterApStage2('Invoice attached, amount due $1,234.56', []).pass).toBe(true)
  })
  it('a body with no invoice signal is rejected', () => {
    expect(prefilterApStage2('lunch on friday?', []).pass).toBe(false)
  })
})

describe('pickInvoiceAttachments', () => {
  it('PDFs first, invoice-looking names first, logos skipped, at most 3', () => {
    const picked = pickInvoiceAttachments([
      { name: 'logo.png', contentType: 'image/png', size: 4_000 },
      { name: 'photo.jpg', contentType: 'image/jpeg', size: 90_000 },
      { name: 'terms.pdf', contentType: 'application/pdf', size: 30_000 },
      { name: 'invoice-55.pdf', contentType: 'application/pdf', size: 30_000 },
      { name: 'x.pdf', contentType: 'application/pdf', size: 30_000 },
      { name: 'huge.pdf', contentType: 'application/pdf', size: 20_000_000 },
    ])
    expect(picked.map((a) => a.name)).toEqual(['invoice-55.pdf', 'terms.pdf', 'x.pdf'])
  })
})
