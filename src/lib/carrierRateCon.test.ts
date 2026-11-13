// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { PDFDocument, PDFRawStream, PDFArray, PDFRef, decodePDFRawStream } from 'pdf-lib'
import {
  buildRateConPdf, foldAscii, joinRateConNotes, rateConChargeLabel, rateConFilename, rateConRepOf, stampSignature,
  RATE_CON_SIGNATURE_ANCHOR,
} from './carrierRateCon'
import type { RateConInput, RateConStop } from './carrierRateCon'
import { RATE_CON_TERMS } from './carrierRateConTerms'

/** The text drawn on each page, one string per `Tj`, in draw order. */
async function pagesText(bytes: Uint8Array): Promise<string[][]> {
  const pdf = await PDFDocument.load(bytes)
  return pdf.getPages().map((page) => {
    const contents = page.node.Contents()
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents]
    const out: string[] = []
    for (const ref of refs) {
      const stream = pdf.context.lookup(ref as PDFRef)
      if (!(stream instanceof PDFRawStream)) continue
      const source = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
      for (const m of source.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        out.push(Buffer.from(m[1], 'hex').toString('latin1'))
      }
    }
    return out
  })
}
const allText = async (bytes: Uint8Array) => (await pagesText(bytes)).flat().join('\n')

const loadCarrier = {
  truckNumber: 'T-44', trailerNumber: 'TR-9', driverName: 'Dana Driver', driverPhone: '3125550199',
}

const pickup = (over: Partial<RateConStop> = {}): RateConStop => ({
  kind: 'PICKUP', name: 'Whimsy Intermodal', address: '5100 70th Pl A', city: 'Chicago', state: 'IL', zip: '60638',
  // 11:00 Chicago (CDT) on 2026-10-29.
  apptAt: '2026-10-29T16:00:00.000Z', references: [{ label: 'Ref', value: '1088817' }], ...over,
})
const delivery = (over: Partial<RateConStop> = {}): RateConStop => ({
  kind: 'DELIVERY', name: 'PSI', address: '1901 Gateway Blvd', city: 'Beloit', state: 'WI', zip: '53511',
  apptAt: '2026-10-29T05:00:00.000Z', instructions: 'MUST DELIVER BY 2PM', hours: '0700-1400', ...over,
})

function input(overrides: Partial<RateConInput> = {}): RateConInput {
  return {
    carrier: { name: 'Arctic Horizon Inc', mcNumber: '755670', dotNumber: '2094732', phone: '815-260-3204', fax: '8479841264' },
    loadCarrier,
    rep: { name: 'Ryne Bandolik', phone: '8474500899', email: 'ryne@bcatcorp.com' },
    loadNumber: '14832',
    issuedAt: new Date('2026-10-26T18:34:25.000Z'),
    equipmentType: 'Flatbed',
    commodity: 'Engines',
    weightLbs: 37000,
    miles: 107,
    pieces: 2,
    stops: [pickup(), delivery()],
    charges: [{ label: 'Line haul rate', amountCents: 80000 }, { label: 'Macropoint acceptance', amountCents: 10000 }],
    totalCents: 90000,
    notes: 'ITL PU# 1088817: 1pc CMAU6278138 11AM',
    ...overrides,
  }
}

describe('buildRateConPdf', () => {
  it('refuses a document whose printed total is not the sum of its charge lines', async () => {
    await expect(buildRateConPdf(input({ totalCents: 80000 }))).rejects.toThrow(/charge lines/)
  })

  it('accepts a zero-charge rate con', async () => {
    const bytes = await buildRateConPdf(input({ charges: [], totalCents: 0 }))
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2)
  })

  it('prints the pulled fields the way the reference rate con does', async () => {
    const text = await allText(await buildRateConPdf(input()))
    for (const want of [
      '14832', '10/26/26 14:34:25', '(EST)', 'RYNE BANDOLIK', '(847) 450-0899 (p)', 'ryne@bcatcorp.com',
      'ARCTIC HORIZON INC', '(815) 260-3204 (p)', '(847) 984-1264 (f)', '755670', '2094732',
      'T-44', 'TR-9', 'DANA DRIVER', '(312) 555-0199', 'FLATBED', 'ENGINES', '37000', '107',
      'LINE HAUL RATE', '800.00', 'MACROPOINT ACCEPTANCE', '100.00', 'TOTAL RATE', '900.00',
      'ITL PU# 1088817: 1pc CMAU6278138 11AM',
      'WHIMSY INTERMODAL', '5100 70TH PL A', 'CHICAGO IL 60638', '10/29/26 @ 11:00', '1088817',
      'PSI', '10/29/26', 'MUST DELIVER BY 2PM', 'Hours : 0700-1400',
      'BCAT LOGISTICS', '1193 E HIGGINS RD', 'ELK GROVE VILLAGE IL 60007',
      'Carrier Signature', 'Send Carrier Bills to the Address Above', 'must appear on all Invoices',
    ]) expect(text, want).toContain(want)
  })

  it('prints the legal terms verbatim, split across two pages with the continuation notice', async () => {
    const pages = await pagesText(await buildRateConPdf(input()))
    expect(pages).toHaveLength(2)
    const terms = (page: string[]) => page.filter((t) => RATE_CON_TERMS.includes(t))
    expect([...terms(pages[0]), ...terms(pages[1])]).toEqual([...RATE_CON_TERMS])
    expect(terms(pages[0]).at(-1)).toBe('broker. Carrier agrees to hold broker harmless from and indemnify broker from')
    expect(pages[0]).toContain('(Rate Confirmation Details on Next Page)')
    expect(pages[1]).not.toContain('(Rate Confirmation Details on Next Page)')
    for (const page of pages) expect(page).toContain('Carrier Signature')
  })

  it('numbers PICK and STOP blocks and prints every stop of a multi-stop load', async () => {
    const text = await allText(await buildRateConPdf(input({
      stops: [pickup(), pickup({ name: 'Joliet Yard' }), delivery(), delivery({ name: 'Springfield DC' })],
    })))
    expect(text.match(/^PICK$/gm)).toHaveLength(2)
    expect(text.match(/^STOP$/gm)).toHaveLength(2)
    for (const name of ['JOLIET YARD', 'SPRINGFIELD DC']) expect(text).toContain(name)
  })

  it('formats appointment windows, FCFS and date-only appointments', async () => {
    const text = await allText(await buildRateConPdf(input({
      stops: [
        pickup({ apptType: 'range', apptEnd: '2026-10-29T18:00:00.000Z' }),
        delivery({ apptType: 'fcfs' }),
      ],
    })))
    expect(text).toContain('10/29/26 @ 11:00 - 13:00')
    expect(text).toContain('10/29/26 FCFS')
  })

  it('prints an FCFS window when the stop has one', async () => {
    const text = await allText(await buildRateConPdf(input({
      stops: [pickup({ apptType: 'fcfs', apptEnd: '2026-10-29T21:00:00.000Z' }), delivery({})],
    })))
    expect(text).toContain('10/29/26 FCFS 11:00 - 16:00')
  })

  it('wraps long dispatch notes and continues them on a following page', async () => {
    const notes = Array.from({ length: 90 }, (_, i) => `NOTE LINE ${i + 1} PLEASE READ CAREFULLY`).join('\n')
    const pages = await pagesText(await buildRateConPdf(input({ notes })))
    expect(pages.length).toBeGreaterThan(2)
    const text = pages.flat().join('\n')
    expect(text).toContain('NOTE LINE 1 PLEASE READ CAREFULLY')
    expect(text).toContain('NOTE LINE 90 PLEASE READ CAREFULLY')
    expect(text).toContain('DISPATCH NOTES (CONT.)')
    // The signing footer and the terms survive the overflow.
    expect(pages.at(-1)).toContain('PLEASE EMAIL INVOICE AND POD TO BILLING@BCATCORP.COM FOR PAYMENT')
  })

  it('paginates a long run of stops without losing the terms', async () => {
    const stops = Array.from({ length: 14 }, (_, i) => (i % 2 ? delivery({ name: `Drop ${i}` }) : pickup({ name: `Pick ${i}` })))
    const pages = await pagesText(await buildRateConPdf(input({ stops })))
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.flat().join('\n')).toContain('DROP 13')
    expect(pages.flat()).toContain(RATE_CON_TERMS[0])
    expect(pages.flat()).toContain(RATE_CON_TERMS.at(-1))
  })

  it('folds non-ASCII to ASCII instead of throwing', async () => {
    const bytes = await buildRateConPdf(input({
      carrier: { name: 'Transportes Mu\u00f1oz \u2013 S.A.', mcNumber: '1', dotNumber: '2', phone: null },
      notes: 'Caf\u00e9 \u201cdock\u201d \u2014 call \u260e now',
    }))
    const text = await allText(bytes)
    expect(text).toContain('TRANSPORTES MUNOZ - S.A.')
    expect(text).toContain('Cafe "dock" - call now')
    expect(foldAscii('\u00c9l ni\u00f1o')).toBe('El nino')
  })

  it('prints carrier money only: exactly the charge lines it is handed, nothing priced elsewhere', async () => {
    const text = await allText(await buildRateConPdf(input()))
    expect(text.match(/\d[\d,]*\.\d{2}/g)?.sort()).toEqual(['100.00', '800.00', '900.00'])
  })

  it('leaves the FROM box and carrier blanks empty rather than printing "null"', async () => {
    const text = await allText(await buildRateConPdf(input({
      rep: null, loadCarrier: { truckNumber: null, trailerNumber: null, driverName: null, driverPhone: null },
      carrier: { name: 'Solo Hauling', mcNumber: null, dotNumber: null, phone: null },
    })))
    expect(text).not.toMatch(/null|undefined/)
  })

  it('shows a short Aljex charge code as words, never cut', async () => {
    const text = await allText(await buildRateConPdf(input({
      charges: [{ label: 'MAC', amountCents: 10000 }, { label: 'Some Unknown Accessorial', amountCents: 5000 }],
      totalCents: 15000,
    })))
    expect(text).toContain('MACROPOINT ACCEPTANCE')
    expect(rateConChargeLabel('detn')).toBe('DETENTION')
    expect(rateConChargeLabel('Weird thing')).toBe('WEIRD THING')
  })

  it('gives the FROM box the company phone and name when the rep has neither', async () => {
    const text = await allText(await buildRateConPdf(input({ rep: { name: null, phone: null, email: 'ryne@bcatcorp.com' } })))
    expect(text).toContain('(847) 450-0899 (p)')
    expect(text).toContain('ryne@bcatcorp.com')
  })
})

describe('rateConRepOf', () => {
  const profiles = [{ email: 'Ryne@bcatcorp.com', name: 'Ryne Bandolik', phone: '8474500899' }]
  it('takes the first e-mail given and enriches it from the directory, case-insensitively', () => {
    expect(rateConRepOf(profiles, null, 'ryne@bcatcorp.com', 'other@x.test')).toEqual({
      name: 'Ryne Bandolik', phone: '8474500899', email: 'ryne@bcatcorp.com',
    })
  })
  it('keeps the bare e-mail for an unknown user and is null with nobody', () => {
    expect(rateConRepOf(profiles, 'new@bcatcorp.com')).toEqual({ name: null, phone: null, email: 'new@bcatcorp.com' })
    expect(rateConRepOf(profiles, undefined, '')).toBeNull()
  })
  it('finds the rep by profile id when the load stores a Cognito username', () => {
    const withId = [{ id: 'u-123', email: 'rep@bcatcorp.com', name: 'Rae Rep', phone: '8475550101' }]
    expect(rateConRepOf(withId, 'u-123', 'someone@x.test')).toEqual({ name: 'Rae Rep', phone: '8475550101', email: 'rep@bcatcorp.com' })
    expect(rateConRepOf(withId, 'u-unknown', 'rep@bcatcorp.com')?.name).toBe('Rae Rep')
    expect(rateConRepOf(withId, 'u-unknown')).toBeNull()
  })
})

describe('signature anchor', () => {
  it('points at the signature and date lines the footer draws, on a letter page', () => {
    const { signatureLine, dateLine } = RATE_CON_SIGNATURE_ANCHOR
    expect(signatureLine.x + signatureLine.width).toBeLessThan(dateLine.x)
    expect(dateLine.x + dateLine.width).toBeLessThan(612)
    expect(signatureLine.y).toBeGreaterThan(0)
  })
})

describe('joinRateConNotes', () => {
  it('joins special instructions and rate-con notes in print order, skipping blanks', () => {
    expect(joinRateConNotes(' A ', 'B')).toBe('A\n\nB')
    expect(joinRateConNotes(undefined, 'B')).toBe('B')
    expect(joinRateConNotes('', null)).toBe('')
  })
})

describe('stampSignature', () => {
  it('appends exactly one page to the signed document', async () => {
    const fixture = await PDFDocument.create()
    fixture.addPage()
    fixture.addPage()
    const stamped = await stampSignature(await fixture.save(), {
      name: 'Dana Driver',
      ip: '203.0.113.9',
      at: '2026-02-01T12:00:00.000Z',
      fields: { 'Driver name': 'Dana Driver', 'Driver phone': '312-555-0199', 'Truck number': '4412' },
    })
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(3)
  })

  it('appends one page even with no filled fields, onto a real rate con', async () => {
    const built = await buildRateConPdf(input())
    const pages = (await PDFDocument.load(built)).getPageCount()
    const stamped = await stampSignature(built, {
      name: 'Dana Driver', ip: '203.0.113.9', at: '2026-02-01T12:00:00.000Z', fields: {},
    })
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(pages + 1)
  })
})

describe('rateConFilename', () => {
  it('names the file by load and version', () => {
    expect(rateConFilename('BC-1001', 1)).toBe('rate-con-BC-1001-v1.pdf')
    expect(rateConFilename('BC-1001', 3)).toBe('rate-con-BC-1001-v3.pdf')
  })
})
