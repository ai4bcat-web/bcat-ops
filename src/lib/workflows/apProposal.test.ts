/**
 * Money becomes cents once, here, and a reference is only reported when the invoice
 * said what it was. A carrier invoice is mostly numbers that are not references.
 */
import { describe, it, expect } from 'vitest'
import { carrierBillFrom, centsFromDollars, documentFor, shipmentRefsIn } from './apProposal'

describe('centsFromDollars', () => {
  it('rounds to integer cents and keeps zero', () => {
    expect(centsFromDollars(12.345)).toBe(1235)
    expect(centsFromDollars(0)).toBe(0)
    expect(centsFromDollars(1850)).toBe(185000)
    expect(centsFromDollars('$1,850.50')).toBe(185050)
  })

  it('refuses anything that is not an amount owed', () => {
    expect(centsFromDollars(-5)).toBeNull()
    expect(centsFromDollars('n/a')).toBeNull()
    expect(centsFromDollars(null)).toBeNull()
    expect(centsFromDollars(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('shipmentRefsIn', () => {
  it('finds a PRO and a shipment number and leaves a phone number alone', () => {
    const text = [
      'Invoice for PRO# 13364 against shipment S000123.',
      'Questions: call 312-555-0147 or 3125550147.',
      'Reply to billing@megacarrier.com, ref 99881.',
    ].join('\n')

    const refs = shipmentRefsIn(text)
    expect(refs.pros).toEqual(['13364'])
    expect(refs.numbers).toEqual(['S000123'])
    expect(refs.others).toContain('99881')

    const everything = [...refs.pros, ...refs.numbers, ...refs.others].join(' ')
    expect(everything).not.toContain('3125550147')
    expect(everything).not.toContain('555')
  })

  it('does not read digits out of an e-mail address', () => {
    expect(shipmentRefsIn('write to ap2024@carrier000111.com').numbers).toEqual([])
  })
})

describe('carrierBillFrom', () => {
  it('carries the match through and the amount as cents', () => {
    const proposal = carrierBillFrom(
      { invoiceNumber: ' INV-88 ', amountDollars: '2,400.00', invoiceDate: '2026-10-01' },
      { carrierId: 'car-1', carrierName: 'Mega Carrier', shipmentId: 'shp-1', shipmentNumber: 'S000123' },
    )
    expect(proposal).toEqual({
      kind: 'CARRIER_BILL',
      invoiceNumber: 'INV-88',
      amountCents: 240000,
      invoiceDate: '2026-10-01',
      dueDate: null,
      loadCarrierId: null,
      carrierId: 'car-1',
      carrierName: 'Mega Carrier',
      shipmentId: 'shp-1',
      shipmentNumber: 'S000123',
      confidence: null,
    })
  })

  it('leaves the amount null rather than guessing one', () => {
    expect(carrierBillFrom({ amountDollars: 'see attached' }, {}).amountCents).toBeNull()
  })
})

describe('documentFor', () => {
  it('points at the object instead of carrying it', () => {
    expect(documentFor('workflow-inbox/wf-1/inv.pdf', 'inv.pdf', 'application/pdf', 1024)).toEqual({
      s3Key: 'workflow-inbox/wf-1/inv.pdf',
      name: 'inv.pdf',
      contentType: 'application/pdf',
      size: 1024,
    })
  })
})
