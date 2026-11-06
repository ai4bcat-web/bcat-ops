// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import jsPDF from 'jspdf'
import { drawLetterhead, resolveLetterhead } from './pdfLetterhead'

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('resolveLetterhead', () => {
  it('returns a fitted logo for a PNG and null for every failure', async () => {
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const logo = await resolveLetterhead(doc, { logoKey: 'k' }, async () => PNG_1X1)
    expect(logo?.format).toBe('PNG')
    expect(logo && logo.width <= 150 && logo.height <= 38).toBe(true)
    expect(await resolveLetterhead(doc, { logoKey: null }, async () => PNG_1X1)).toBeNull()
    expect(await resolveLetterhead(doc, { logoKey: 'k' }, async () => null)).toBeNull()
    expect(await resolveLetterhead(doc, { logoKey: 'k' }, async () => 'data:image/png;base64,AAAA')).toBeNull()
    expect(await resolveLetterhead(doc, { logoKey: 'k' }, async () => { throw new Error('x') })).toBeNull()
  })
})

describe('drawLetterhead', () => {
  it('draws the same logo alias once however many pages use it', async () => {
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const logo = await resolveLetterhead(doc, { logoKey: 'k' }, async () => PNG_1X1)
    const content = { legalName: 'Acme LLC', ids: 'MC 1', title: 'T', subtitle: 'S', logo }
    const images = () => (doc.output().match(/\/Subtype \/Image/g) ?? []).length
    drawLetterhead(doc, content)
    const once = images()
    expect(once).toBeGreaterThan(0)
    doc.addPage()
    drawLetterhead(doc, { ...content, detail: '1 Main St' })
    expect(images()).toBe(once)
  })
})
