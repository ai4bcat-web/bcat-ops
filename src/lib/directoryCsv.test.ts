import { describe, expect, it } from 'vitest'
import { flattenRecord, recordsToFullCsv } from './directoryCsv'

describe('directory full CSV', () => {
  it('flattens nested objects to dotted columns, joins plain lists, and keeps complex ones as JSON', () => {
    const flat = flattenRecord({ __typename: 'Carrier', id: 'c1', name: 'ACME', address: { city: 'Joliet', zip: '60435' }, tags: ['a', 'b'], insurancePolicies: [{ type: 'CARGO', limit: 100000 }], active: true, note: null })
    expect(flat).toEqual({
      id: 'c1', name: 'ACME', 'address.city': 'Joliet', 'address.zip': '60435', tags: 'a; b',
      insurancePolicies: '[{"type":"CARGO","limit":100000}]', active: 'true', note: '',
    })
  })

  it('every record and every field: the header is the union, id and name first, a missing field is empty', () => {
    const csv = recordsToFullCsv([{ id: '1', name: 'A', phone: '555' }, { id: '2', name: 'B', mc: 'MC9' }])
    expect(csv.split('\r\n')).toEqual(['id,name,phone,mc', '1,A,555,', '2,B,,MC9'])
  })

  it('quotes commas, quotes and line breaks so a note with all three stays in one cell', () => {
    const csv = recordsToFullCsv([{ id: '1', name: 'Smith, "Bob"\nLtd' }])
    expect(csv).toBe('id,name\r\n1,"Smith, ""Bob""\nLtd"')
  })

  it('an empty directory is just an empty header', () => {
    expect(recordsToFullCsv([])).toBe('')
  })
})
