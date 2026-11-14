import { describe, it, expect } from 'vitest'
import { suggestDocumentType } from './shipmentDocuments'

describe('suggestDocumentType', () => {
  it.each([
    ['POD 14657.pdf', 'POD'],
    ['pod.pdf', 'POD'],
    ['POD14657.pdf', 'POD'],
    ['Proof of Delivery.pdf', 'POD'],
    ['RateConf_4010854523.pdf', 'RATE_CON'],
    ['rate con 20031.pdf', 'RATE_CON'],
    ['rc.pdf', 'RATE_CON'],
    ['Load Confirmation 123.pdf', 'RATE_CON'],
  ])('%s → %s', (name, type) => expect(suggestDocumentType(name)).toBe(type))

  it.each(['tender.pdf', 'lumper.jpg', 'Podium.pdf', 'scan_0001.pdf', 'bol.pdf'])('%s → no guess', (name) => {
    expect(suggestDocumentType(name)).toBeNull()
  })
})
