import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect } from 'vitest'
import { extractUrls } from './handler'
import { parseEfsReport } from './efsParser'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_5DAY = readFileSync(
  resolve(__dirname, '../../../tests/fixtures/fuel-sample.txt'),
  'utf-8',
)

const SAMPLE_DAILY = readFileSync(
  resolve(__dirname, '../../../tests/fixtures/fuel-2026-05-19.txt'),
  'utf-8',
)

// ── extractUrls ───────────────────────────────────────────────────────────────

const FLEET_ONE_URL =
  'https://manage.fleetone.com/cards/CardsJob.action?getJobFile&fileId=26fe5af7-6e95-48be-af7f-75a94598f866.1779257184919.jobdata'

describe('extractUrls — Fleet One CardsJob', () => {
  it('extracts the URL when followed by text with no whitespace delimiter', () => {
    // This is the exact problematic case: URL runs directly into "Please do not reply"
    const body =
      "Job: 'DAILY FUEL REPORT' completed. Download at: " +
      FLEET_ONE_URL +
      'Please do not reply to this email.'

    const urls = extractUrls(body)
    expect(urls).toContain(FLEET_ONE_URL)
  })

  it('does not capture trailing non-URL text as part of the URL', () => {
    const body = FLEET_ONE_URL + 'Please do not reply.'
    const [url] = extractUrls(body)
    expect(url).toBe(FLEET_ONE_URL)
    expect(url).not.toContain('Please')
  })

  it('handles URL followed by a newline (normal case still works)', () => {
    const body = 'Download at: ' + FLEET_ONE_URL + '\nPlease do not reply.'
    const urls = extractUrls(body)
    expect(urls).toContain(FLEET_ONE_URL)
  })

  it('handles URL with different fileId structure', () => {
    const altUrl =
      'https://manage.fleetone.com/cards/CardsJob.action?getJobFile&fileId=abc12345-0000-1111-2222-def678901234.9876543210.jobdata'
    const urls = extractUrls('Download: ' + altUrl + 'Please ignore.')
    expect(urls).toContain(altUrl)
  })

  it('still extracts generic https URLs from the same body', () => {
    const genericUrl = 'https://example.com/some-other-link'
    const body = FLEET_ONE_URL + 'Please ignore. Also see ' + genericUrl
    const urls = extractUrls(body)
    expect(urls).toContain(FLEET_ONE_URL)
    expect(urls).toContain(genericUrl)
  })

  it('deduplicates repeated occurrences of the same URL', () => {
    const body = FLEET_ONE_URL + 'text' + FLEET_ONE_URL + 'more'
    const urls = extractUrls(body)
    expect(urls.filter((u) => u === FLEET_ONE_URL)).toHaveLength(1)
  })

  it('returns empty array for body with no URLs', () => {
    expect(extractUrls('No URLs here at all.')).toHaveLength(0)
  })
})

// ── parseEfsReport — 5-day fixture (fuel-sample.txt) ─────────────────────────

describe('parseEfsReport — 5-day fixture', () => {
  const txs = parseEfsReport(SAMPLE_5DAY)

  it('parses exactly 11 transactions', () => {
    expect(txs).toHaveLength(11)
  })

  it('grand-total validation passes without throwing', () => {
    expect(() => parseEfsReport(SAMPLE_5DAY)).not.toThrow()
  })

  it('card 00007 parses correctly', () => {
    const tx = txs.find((t) => t.cardNumber === '00007')
    expect(tx).toBeDefined()
    expect(tx!.fuelType).toBe('ULSD')
    expect(tx!.itemCategory).toBe('FUEL')
    expect(tx!.driverName).toBe('Armando Arando')
    expect(tx!.transactionDate).toBe('2026-05-18')
    expect(tx!.amount).toBeCloseTo(597.92, 2)
    expect(tx!.quantity).toBeCloseTo(99.67, 2)
    expect(tx!.fees).toBe(0)
  })

  it('card 00023 has fee of $2.00', () => {
    const tx = txs.find((t) => t.cardNumber === '00023')
    expect(tx).toBeDefined()
    expect(tx!.fees).toBeCloseTo(2.00, 2)
    expect(tx!.driverName).toBe('John Nelson')
  })

  it('card 00031 has blank driver name', () => {
    const tx = txs.find((t) => t.cardNumber === '00031')
    expect(tx).toBeDefined()
    expect(tx!.driverName).toBe('')
    expect(tx!.unitNumber).toBe('0530')
  })

  it('card 00049 produces 6 transactions (all ULSD)', () => {
    const t49 = txs.filter((t) => t.cardNumber === '00049')
    expect(t49).toHaveLength(6)
    expect(t49.every((t) => t.fuelType === 'ULSD')).toBe(true)
  })

  it('card 00056 continuation row — DEFD + ULSD both parsed correctly', () => {
    const t56 = txs.filter((t) => t.cardNumber === '00056')
    expect(t56).toHaveLength(2)
    const defd = t56.find((t) => t.fuelType === 'DEFD')!
    const ulsd = t56.find((t) => t.fuelType === 'ULSD')!
    expect(defd.itemCategory).toBe('FUEL')
    expect(ulsd.itemCategory).toBe('FUEL')
    // Continuation row must inherit primary row's header fields
    expect(ulsd.invoiceNumber).toBe(defd.invoiceNumber)
    expect(ulsd.transactionDate).toBe(defd.transactionDate)
    expect(ulsd.cardNumber).toBe('00056')
    expect(defd.amount).toBeCloseTo(30.44, 2)
    expect(defd.quantity).toBeCloseTo(6.09, 2)
    expect(ulsd.amount).toBeCloseTo(685.14, 2)
  })

  it('ULSD sum matches grand total', () => {
    const sum = txs.filter((t) => t.fuelType === 'ULSD').reduce((s, t) => s + t.amount, 0)
    expect(sum).toBeCloseTo(3757.82, 1)
  })

  it('DEFD sum matches grand total', () => {
    const sum = txs.filter((t) => t.fuelType === 'DEFD').reduce((s, t) => s + t.amount, 0)
    expect(sum).toBeCloseTo(30.44, 2)
  })

  it('fees sum matches grand total', () => {
    const sum = txs.reduce((s, t) => s + t.fees, 0)
    expect(sum).toBeCloseTo(4.00, 2)
  })

  it('all transactions have itemCategory FUEL', () => {
    expect(txs.every((t) => t.itemCategory === 'FUEL')).toBe(true)
  })
})

// ── parseEfsReport — 2026-05-19 daily fixture ─────────────────────────────────

describe('parseEfsReport — 2026-05-19 daily fixture', () => {
  const txs = parseEfsReport(SAMPLE_DAILY)

  it('grand-total validation passes without throwing', () => {
    expect(() => parseEfsReport(SAMPLE_DAILY)).not.toThrow()
  })

  it('parses exactly 5 transactions', () => {
    expect(txs).toHaveLength(5)
  })

  it('all transactions are dated 2026-05-19', () => {
    expect(txs.every((t) => t.transactionDate === '2026-05-19')).toBe(true)
  })

  it('ULSD total amount = $1,957.72', () => {
    const sum = txs.filter((t) => t.fuelType === 'ULSD').reduce((s, t) => s + t.amount, 0)
    expect(sum).toBeCloseTo(1957.72, 2)
  })

  it('ULSD total quantity = 358.65 gal', () => {
    const sum = txs.filter((t) => t.fuelType === 'ULSD').reduce((s, t) => s + t.quantity, 0)
    expect(sum).toBeCloseTo(358.65, 2)
  })

  it('DEFD total amount = $34.06', () => {
    const sum = txs.filter((t) => t.fuelType === 'DEFD').reduce((s, t) => s + t.amount, 0)
    expect(sum).toBeCloseTo(34.06, 2)
  })

  it('DEFD total quantity = 8.52 gal', () => {
    const sum = txs.filter((t) => t.fuelType === 'DEFD').reduce((s, t) => s + t.quantity, 0)
    expect(sum).toBeCloseTo(8.52, 2)
  })

  it('total fees = $2.00 (card 00023 LOVES stop)', () => {
    const sum = txs.reduce((s, t) => s + t.fees, 0)
    expect(sum).toBeCloseTo(2.00, 2)
  })

  it('card 00031 has blank driver name', () => {
    const tx = txs.find((t) => t.cardNumber === '00031')
    expect(tx).toBeDefined()
    expect(tx!.driverName).toBe('')
    expect(tx!.unitNumber).toBe('0530')
  })

  it('card 00056 produces 2 transactions (DEFD + ULSD continuation)', () => {
    const t56 = txs.filter((t) => t.cardNumber === '00056')
    expect(t56).toHaveLength(2)
    const defd = t56.find((t) => t.fuelType === 'DEFD')!
    const ulsd = t56.find((t) => t.fuelType === 'ULSD')!
    expect(defd).toBeDefined()
    expect(ulsd).toBeDefined()
    // Continuation row must inherit card/date/invoice from primary
    expect(ulsd.cardNumber).toBe('00056')
    expect(ulsd.transactionDate).toBe('2026-05-19')
    expect(ulsd.invoiceNumber).toBe(defd.invoiceNumber)
    expect(defd.amount).toBeCloseTo(34.06, 2)
    expect(ulsd.amount).toBeCloseTo(360.96, 2)
  })

  it('all transactions have itemCategory FUEL', () => {
    expect(txs.every((t) => t.itemCategory === 'FUEL')).toBe(true)
  })

  it('all 4 BCAT card numbers are represented', () => {
    const cards = new Set(txs.map((t) => t.cardNumber))
    expect(cards.has('00007')).toBe(true)
    expect(cards.has('00023')).toBe(true)
    expect(cards.has('00031')).toBe(true)
    expect(cards.has('00056')).toBe(true)
  })
})
