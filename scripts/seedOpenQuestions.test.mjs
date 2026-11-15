import { describe, expect, it } from 'vitest'
import { OPEN_QUESTION_PAGE, buildRow, resolveRef } from './seedOpenQuestions.mjs'

const ctx = {
  shipmentsByNumber: new Map([['14598', { id: 'shp-a' }], ['14096', { id: 'shp-b' }]]),
  billsByShipment: new Map([['shp-a', [
    { id: 'cb-1', carrierName: 'ARCTIC HORIZON INC', status: 'TO_BE_PAID' },
    { id: 'cb-2', carrierName: 'N VISION INC', status: 'TO_BE_PAID' },
  ]]]),
  invoicesByShipment: new Map([['shp-b', [{ id: '14096', balanceCents: 0 }, { id: '14096-2', balanceCents: 5250 }]]]),
}

describe('seedOpenQuestions', () => {
  it('resolves a PRO to its shipment, the named carrier bill and the open invoice', () => {
    expect(resolveRef({ pro: 14598, bill: 'vision', amount: '$100.00' }, ctx)).toEqual({ pro: '14598', shipmentId: 'shp-a', billId: 'cb-2', amount: '$100.00' })
    expect(resolveRef({ pro: '14598', bill: true }, ctx)).toEqual({ pro: '14598', shipmentId: 'shp-a' })
    expect(resolveRef({ pro: '14096', invoice: true }, ctx)).toEqual({ pro: '14096', shipmentId: 'shp-b', invoiceId: '14096-2' })
    expect(resolveRef({ pro: '11451' }, ctx)).toEqual({ pro: '11451' })
  })

  it('builds a stable open Feedback row', () => {
    const row = buildRow({ key: 'ap-14619', area: 'AP', question: 'Paid?', aljex: 'Open', bcat: 'Paid' }, [{ pro: '14619' }], '2026-11-15T00:00:00.000Z')
    expect(row).toMatchObject({ id: 'oq-ap-14619', page: OPEN_QUESTION_PAGE, summary: 'Paid?', status: 'NEW', __typename: 'Feedback' })
    expect(JSON.parse(row.details)).toEqual({ area: 'AP', refs: [{ pro: '14619' }], aljex: 'Open', bcat: 'Paid' })
    expect(JSON.parse(buildRow({ key: 'k', area: 'ZZ', question: 'q' }, [], 'n').details).area).toBe('OTHER')
    expect(() => buildRow({ question: 'q' }, [], 'n')).toThrow()
  })
})
