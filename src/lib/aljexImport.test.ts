import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { guessAljexMapping, mapAljexRow, normalizeHeader, parseCsvRows } from './aljexImport'

describe('normalizeHeader', () => {
  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeHeader('  Customer MC  ')).toBe('customer mc')
  })

  it('collapses inner whitespace runs', () => {
    expect(normalizeHeader('Origin   City')).toBe('origin city')
  })

  it('strips a UTF-8 BOM left by spreadsheet exports', () => {
    expect(normalizeHeader('﻿Pro #')).toBe('pro #')
  })
})

describe('parseCsvRows', () => {
  it('splits a header row and data rows', () => {
    const { headers, rows } = parseCsvRows('Pro #,Customer\n90001,ACME\n90002,BATORY')
    expect(headers).toEqual(['Pro #', 'Customer'])
    expect(rows).toEqual([
      ['90001', 'ACME'],
      ['90002', 'BATORY'],
    ])
  })

  it('keeps commas inside quoted fields', () => {
    const { rows } = parseCsvRows('Customer,Weight\n"ACME, INC",42000')
    expect(rows).toEqual([['ACME, INC', '42000']])
  })

  it('unescapes doubled quotes inside quoted fields', () => {
    const { rows } = parseCsvRows('Commodity\n"10"" Widgets"')
    expect(rows).toEqual([['10" Widgets']])
  })

  it('handles CRLF line endings and a BOM', () => {
    const { headers, rows } = parseCsvRows('﻿Pro #,Customer\r\n90001,ACME\r\n')
    expect(headers).toEqual(['Pro #', 'Customer'])
    expect(rows).toEqual([['90001', 'ACME']])
  })

  it('preserves empty trailing cells', () => {
    const { rows } = parseCsvRows('A,B,C\n1,,')
    expect(rows).toEqual([['1', '', '']])
  })

  it('skips blank lines between records', () => {
    const { rows } = parseCsvRows('A\n1\n\n2\n')
    expect(rows).toEqual([['1'], ['2']])
  })

  it('pads short rows and truncates long rows to the header width', () => {
    const { rows } = parseCsvRows('A,B\n1\n2,3,4')
    expect(rows).toEqual([
      ['1', ''],
      ['2', '3'],
    ])
  })

  it('returns empty headers and rows for empty input', () => {
    expect(parseCsvRows('')).toEqual({ headers: [], rows: [] })
  })
})

describe('guessAljexMapping', () => {
  it('maps canonical Aljex headers', () => {
    const mapping = guessAljexMapping(['Pro #', 'Customer', 'Origin City', 'Status'])
    expect(mapping.pro).toBe('Pro #')
    expect(mapping.customer).toBe('Customer')
    expect(mapping.originCity).toBe('Origin City')
    expect(mapping.status).toBe('Status')
  })

  it('maps documented aliases to the same targets', () => {
    const mapping = guessAljexMapping(['Shipper', 'Sell Rate', 'AR Invoice', 'AP Amount', 'Paid Date'])
    expect(mapping.customer).toBe('Shipper')
    expect(mapping.customerRate).toBe('Sell Rate')
    expect(mapping.invoiceNumber).toBe('AR Invoice')
    expect(mapping.carrierBillAmount).toBe('AP Amount')
    expect(mapping.invoicePaidDate).toBe('Paid Date')
  })

  it('matches headers case- and punctuation-insensitively', () => {
    const mapping = guessAljexMapping(['pro number', 'CARRIER  MC'])
    expect(mapping.pro).toBe('pro number')
    expect(mapping.carrierMc).toBe('CARRIER  MC')
  })

  it('ignores headers that are not Aljex columns', () => {
    const mapping = guessAljexMapping(['Internal Notes', 'Dispatcher'])
    expect(Object.keys(mapping)).toHaveLength(0)
  })

  it('assigns each header to at most one target', () => {
    // "Customer" is an alias for customer; it must not also satisfy another target.
    const mapping = guessAljexMapping(['Customer', 'Customer Name'])
    expect(mapping.customer).toBe('Customer')
    expect(Object.values(mapping).filter((h) => h === 'Customer')).toHaveLength(1)
  })
})

describe('mapAljexRow', () => {
  const headers = ['Pro #', 'Customer', 'Weight', 'Customer Rate', 'Pickup Date', 'Status']
  const mapping = guessAljexMapping(headers)

  it('maps cells to canonical fields using the guessed mapping', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', '2450.00', '11/02/2026', 'Booked'], mapping)
    expect(row.pro).toBe('90001')
    expect(row.customer).toBe('ACME')
    expect(row.weight).toBe(42000)
  })

  it('converts dollar amounts to cents', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', '$1,650.00', '11/02/2026', 'Booked'], mapping)
    expect(row.customerRateCents).toBe(165000)
  })

  it('parses integers with thousands separators', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42,000', '2450', '11/02/2026', 'Booked'], mapping)
    expect(row.weight).toBe(42000)
    expect(row.customerRateCents).toBe(245000)
  })

  it('normalizes US short dates to YYYY-MM-DD', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', '2450', '11/02/2026', 'Booked'], mapping)
    expect(row.pickupDate).toBe('2026-11-02')
  })

  it('normalizes known statuses and keeps the raw value', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', '2450', '11/02/2026', 'In Transit'], mapping)
    expect(row.status).toBe('IN_TRANSIT')
    expect(row.rawStatus).toBe('In Transit')
  })

  it('maps Paid to DELIVERED', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', '2450', '11/02/2026', 'Paid'], mapping)
    expect(row.status).toBe('DELIVERED')
  })

  it('defaults unknown statuses to OPEN with a note', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', '2450', '11/02/2026', 'Frobnicated'], mapping)
    expect(row.status).toBe('OPEN')
    expect(row.rawStatus).toBe('Frobnicated')
    expect(row.note).toContain('Frobnicated')
  })

  it('leaves unmapped and empty fields undefined', () => {
    const row = mapAljexRow(headers, ['', 'ACME', '', '', '', ''], mapping)
    expect(row.pro).toBeUndefined()
    expect(row.weight).toBeUndefined()
    expect(row.customerRateCents).toBeUndefined()
    expect(row.pickupDate).toBeUndefined()
    expect(row.status).toBeUndefined()
    expect(row.po).toBeUndefined()
  })

  it('ignores non-numeric money instead of producing NaN', () => {
    const row = mapAljexRow(headers, ['90001', 'ACME', '42000', 'call for rate', '11/02/2026', 'Booked'], mapping)
    expect(row.customerRateCents).toBeUndefined()
  })
})

describe('aljex-sample fixture', () => {
  const csv = readFileSync(new URL('../../scripts/fixtures/aljex-sample.csv', import.meta.url), 'utf8')
  const { headers, rows } = parseCsvRows(csv)
  const mapping = guessAljexMapping(headers)
  const mapped = rows.map((cells) => mapAljexRow(headers, cells, mapping))

  it('has the five scenario rows from the N1 plan', () => {
    expect(rows).toHaveLength(5)
  })

  it('guesses a full mapping from the fixture headers, including aliases', () => {
    expect(mapping.pro).toBe('Pro #')
    expect(mapping.customer).toBe('Customer')
    expect(mapping.customerMc).toBe('Shipper MC')
    expect(mapping.invoicePaidDate).toBe('Paid Date')
    expect(mapping.carrierBillNumber).toBe('Bill #')
    expect(mapping.carrierBillAmount).toBe('Bill Amount')
    expect(mapping.status).toBe('Status')
  })

  it('row 1 is a new customer with new origin and destination', () => {
    const row = mapped[0]
    expect(row.customer).toBe('ACME PRODUCE CO')
    expect(row.originName).toBe('ACME Packing Shed')
    expect(row.originCity).toBe('Fresno')
    expect(row.destinationName).toBe('Midwest Grocery DC')
    expect(row.destinationCity).toBe('Joliet')
    expect(row.status).toBe('BOOKED')
  })

  it('row 2 uses a customer that already exists on dev', () => {
    const row = mapped[1]
    expect(row.customer).toBe('BATORY FOODS')
    expect(row.status).toBe('IN_TRANSIT')
  })

  it('row 3 is a delivered shipment with a paid invoice', () => {
    const row = mapped[2]
    expect(row.status).toBe('DELIVERED')
    expect(row.invoiceNumber).toBe('INV-5001')
    expect(row.invoiceAmountCents).toBe(187500)
    expect(row.invoicePaidDate).toBe('2026-10-28')
  })

  it('row 4 is a delivered shipment with a carrier bill', () => {
    const row = mapped[3]
    expect(row.status).toBe('DELIVERED')
    expect(row.carrierBillNumber).toBe('CB-7001')
    expect(row.carrierBillAmountCents).toBe(155000)
    expect(row.invoiceNumber).toBeUndefined()
  })

  it('row 5 duplicates the PRO of row 1 to exercise conflict counting', () => {
    expect(mapped[4].pro).toBe(mapped[0].pro)
    expect(mapped[4].pro).toBe('90001')
  })
})
