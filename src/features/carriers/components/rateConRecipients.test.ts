import { describe, expect, it } from 'vitest'
import { commitAddress, defaultSelection, knownRecipientOptions, parseCcList } from './rateConRecipients'
import type { CarrierContactRecord, CarrierRecord, LoadCarrierRecord } from '@/types/tms'

const contact = (over: Partial<CarrierContactRecord>) =>
  ({ id: 'c', carrierId: 'car', name: 'X', active: true, ...over }) as CarrierContactRecord
const carrier = (over: Partial<CarrierRecord> = {}) => ({ id: 'car', name: 'Swift', ...over }) as CarrierRecord

describe('knownRecipientOptions', () => {
  it('lists contacts, booking dispatcher, carrier dispatcher, carrier e-mail in order with labels', () => {
    const options = knownRecipientOptions({
      carrier: carrier({ dispatcherEmail: 'cd@swift.com', email: 'main@swift.com' }),
      contacts: [contact({ name: 'Dana', email: 'dana@swift.com', types: ['DISPATCH'] })],
      loadCarrier: { dispatcherEmail: 'book@swift.com' } as LoadCarrierRecord,
    })
    expect(options).toEqual([
      { email: 'dana@swift.com', label: 'Dana · Dispatch' },
      { email: 'book@swift.com', label: 'Dispatcher on this booking' },
      { email: 'cd@swift.com', label: 'Carrier dispatcher' },
      { email: 'main@swift.com', label: 'Carrier e-mail' },
    ])
  })

  it('omits inactive contacts and malformed addresses, and dedupes case-insensitively keeping the first label', () => {
    const options = knownRecipientOptions({
      carrier: carrier({ dispatcherEmail: 'DANA@swift.com', email: 'not an email' }),
      contacts: [
        contact({ name: 'Dana', email: 'dana@swift.com' }),
        contact({ name: 'Gone', email: 'gone@swift.com', active: false }),
        contact({ name: 'Bad', email: 'bad@' }),
      ],
      loadCarrier: null,
    })
    expect(options.map((o) => o.email)).toEqual(['dana@swift.com'])
    expect(options[0].label).toBe('Dana')
  })
})

describe('defaultSelection', () => {
  it('picks flagged or DISPATCH contacts', () => {
    expect(defaultSelection({
      carrier: carrier({ email: 'main@swift.com' }),
      contacts: [
        contact({ email: 'a@swift.com', types: ['DISPATCH'] }),
        contact({ email: 'b@swift.com', rateConRecipient: true }),
        contact({ email: 'c@swift.com', types: ['ACCOUNTING'] }),
        contact({ email: 'd@swift.com', types: ['DISPATCH'], active: false }),
      ],
    })).toEqual(['a@swift.com', 'b@swift.com'])
  })

  it('falls back to the carrier dispatcher and main e-mail when no contact qualifies', () => {
    expect(defaultSelection({
      carrier: carrier({ dispatcherEmail: 'cd@swift.com', email: 'main@swift.com' }),
      contacts: [contact({ email: 'c@swift.com', types: ['ACCOUNTING'] })],
    })).toEqual(['cd@swift.com', 'main@swift.com'])
  })
})

describe('parseCcList', () => {
  it('splits on commas, semicolons and whitespace and reports invalid tokens', () => {
    expect(parseCcList('a@b.com, bad ; c@d.com')).toEqual({ emails: ['a@b.com', 'c@d.com'], invalid: ['bad'] })
  })
})

describe('commitAddress', () => {
  const options = [{ email: 'dana@swift.com', label: 'Dana' }]
  it('rejects invalid input without changing state', () => {
    expect(commitAddress({ text: 'x@', options, selected: [], extras: [] }))
      .toEqual({ ok: false, error: '"x@" is not a valid email address.' })
  })
  it('ticks an equal option rather than adding a duplicate', () => {
    expect(commitAddress({ text: 'DANA@swift.com', options, selected: [], extras: [] }))
      .toEqual({ ok: true, selected: ['dana@swift.com'], extras: [] })
  })
})
