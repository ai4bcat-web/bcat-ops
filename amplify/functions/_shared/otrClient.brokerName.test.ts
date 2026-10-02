/**
 * Pulling the broker's name out of a broker-check reply.
 *
 * Only `message` was ever read from that endpoint, so whether OTR also says WHO the MC
 * belongs to was never established either way. The factoring queue wants that name above
 * all else — an MC is nine digits nobody recognises — and broker-check is the one call
 * that has the MC and runs before an invoice exists.
 *
 * Rather than hard-code a field nobody has seen, the reader looks for a name-ish key and
 * returns null when there is none. Both answers are correct, so these pin the behaviour
 * for whichever shape OTR turns out to send.
 */
import { describe, it, expect } from 'vitest'
import { brokerNameFrom } from './otrClient'

describe('brokerNameFrom', () => {
  it('reads the field createInvoice already uses, if broker-check sends it too', () => {
    expect(brokerNameFrom({ message: 'APPROVED', brokerName: 'AmeriFreight Systems LLC' }))
      .toBe('AmeriFreight Systems LLC')
  })

  it('accepts the other names OTR uses for the same party', () => {
    expect(brokerNameFrom({ clientName: 'Schneider Logistics' })).toBe('Schneider Logistics')
    expect(brokerNameFrom({ debtorName: 'Total Quality Logistics' })).toBe('Total Quality Logistics')
  })

  it('prefers brokerName when a reply carries more than one', () => {
    // clientName is who OTR bills; brokerName is the party on the load. On a factoring row
    // the broker is the one being described.
    expect(brokerNameFrom({ clientName: 'Ivan Cartage', brokerName: 'AmeriFreight' }))
      .toBe('AmeriFreight')
  })

  it('finds it one level down, where a reply wraps its subject', () => {
    expect(brokerNameFrom({ message: 'APPROVED', broker: { mc: '123456', name: 'Landstar' } }))
      .toBe('Landstar')
  })

  it('returns null when the reply only carries a decision', () => {
    // The shape we currently assume. Null means the office types the name, which is
    // exactly what happens today — not an error.
    expect(brokerNameFrom({ message: 'APPROVED' })).toBeNull()
  })

  it('ignores a blank name rather than wiping a real one with it', () => {
    expect(brokerNameFrom({ brokerName: '   ' })).toBeNull()
  })

  it('survives a reply that is not an object at all', () => {
    expect(brokerNameFrom('APPROVED')).toBeNull()
    expect(brokerNameFrom(null)).toBeNull()
    expect(brokerNameFrom(undefined)).toBeNull()
  })
})
