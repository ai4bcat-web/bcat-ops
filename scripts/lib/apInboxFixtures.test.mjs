import { describe, it, expect } from 'vitest'
import { buildInvoicePdf, buildCorpus, rawExtraction, expectedCounts, BANK_SENTINEL } from './apInboxFixtures.mjs'

const leg = (pro, amount) => ({ pro, amount })
const world = () => ({
  stamp: 1700, now: 1_800_000_000_000, today: '2026-11-04', dayPlus: (n) => new Date(Date.UTC(2026, 10, 4) + n * 86_400_000).toISOString().slice(0, 10),
  carrier: { name: 'ZZ AG Carrier 1700', mc: '9170000', dot: '9170000', remit: 'ZZ AG Carrier 1700' }, otherMc: '9999999',
  legs: { B1: leg('ZZAG1', 1111.11), B2: leg('ZZAG2', 2222.22), B3: { ...leg('ZZAG3', 3333.33), billNumber: 'TYPED-3', billDate: '2026-10-30' }, B4: leg('ZZAG4', 4444.44), B5: leg('ZZAG5', 5555.55), B6: leg('ZZAG6', 6666.66), B7: leg('ZZAG7', 7777.77) },
  vendor: { name: 'ZZ AG Tire Co', invoiceNumber: 'ZZAGV-1700', amount: 480, otherName: 'ZZ AG Other Vendor' },
})

describe('buildInvoicePdf', () => {
  const pdf = buildInvoicePdf({ vendor: 'V', invoiceNumber: 'I-1', pro: 'P1', date: '2026-11-01', amount: 12.5 })
  it('is a PDF big enough for the stage-2 document floor', () => {
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThanOrEqual(8 * 1024)
    expect(pdf.toString()).toContain('Amount due: $12.50')
  })
  it('has an xref table whose offsets land on the objects and a startxref on the table', () => {
    const text = pdf.toString('latin1')
    const start = Number(/startxref\n(\d+)\n/.exec(text)[1])
    expect(text.slice(start, start + 4)).toBe('xref')
    const offsets = [...text.slice(start).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]))
    expect(offsets).toHaveLength(5)
    offsets.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`))
  })
})

describe('buildCorpus', () => {
  const corpus = buildCorpus(world())
  it('covers the 15 distinct mail cases and the duplicate delivery shares its original id', () => {
    expect(corpus).toHaveLength(15)
    const ids = corpus.map((m) => m.id)
    expect(new Set(ids).size).toBe(14)
    expect(corpus.find((m) => m.expect.duplicate).message.id).toBe(corpus[0].message.id)
  })
  it('gives every real attachment a size that matches its bytes and passes the document floor', () => {
    for (const m of corpus) for (const a of m.message.attachments ?? []) {
      expect(Buffer.from(a.dataBase64, 'base64').length).toBe(a.size)
      expect(a.size).toBeGreaterThanOrEqual(8 * 1024)
    }
  })
  it('keeps the injected bank number out of the dev extraction remit-to text it will be scrubbed from only in the stored row', () => {
    const m11 = corpus.find((m) => m.n === 'm11')
    expect(m11.message.devExtraction.remitToText).toContain(BANK_SENTINEL)
  })
  it('puts only the look-back-defeating mail before the cursor and dates the rest inside 24 h', () => {
    const now = world().now
    for (const m of corpus) {
      const age = (now - Number(m.message.internalDate)) / 3_600_000
      if (m.expect.beforeCursor) expect(age).toBeGreaterThan(24)
      else expect(age).toBeLessThan(24)
    }
  })
  it('expects 3 bills updated and 9 queue items', () => {
    expect(expectedCounts(corpus)).toEqual({ stored: 12, updated: 3, needReview: 9, reviewed: 13 })
  })
  it('rawExtraction is union-free: only strings, numbers and string arrays', () => {
    for (const v of Object.values(rawExtraction())) expect(['string', 'number'].includes(typeof v) || Array.isArray(v)).toBe(true)
  })
})
