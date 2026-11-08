import { describe, it, expect } from 'vitest'
import {
  DEFAULT_COUNTER_EMAIL_TEMPLATE,
  DEFAULT_OFFER_REQUEST_EMAIL_TEMPLATE,
  DEFAULT_QUOTE_EMAIL_TEMPLATE,
  quoteRecipients,
  quoteTemplateError,
  renderCounterEmail,
  renderOfferRequestEmail,
  renderQuoteEmail,
  templateHasLink,
} from './quoteNotices'
import type { LoadChargeInput, QuoteRecord } from '../types/tms'
import type { Stop } from '../types'

const NOW = '2026-03-18T12:00:00.000Z'
const LINK = 'https://track.bcatcorp.com/q/Tok0123456789abcdefghijklmnopqrs'
const BROKER = 'BCAT Logistics'
const TERMS = 'Payment net 30 from delivery. Detention bills at $75 per hour after two hours.'

const CUSTOMER_NAME = 'Globex Foods Inc'
const INTERNAL_NOTES = 'Do not go below 1200 — Ryne'

const stops: Stop[] = [
  {
    id: 's1',
    type: 'pickup',
    sequence: 0,
    appt: '2026-03-19T14:00:00.000Z',
    name: 'Acme Dock 7',
    city: 'Chicago, IL',
    address: { street: '4400 Internal Way', city: 'Chicago', state: 'IL' },
    driverId: null,
  },
  {
    id: 's2',
    type: 'delivery',
    sequence: 1,
    appt: '2026-03-20T09:00:00.000Z',
    name: 'Danville DC',
    city: 'Danville, IL',
    address: { street: '19 Dock Road', city: 'Danville', state: 'IL' },
    driverId: null,
  },
]

const lines: LoadChargeInput[] = [
  { side: 'CUSTOMER', code: 'LINEHAUL', calculatedBy: 'FLAT', rateCents: 120_000, isRate: true, sortOrder: 0 },
  { side: 'CUSTOMER', code: 'FSC', calculatedBy: 'PERCENT', rateCents: 1_500, isRate: false, sortOrder: 1 },
  { side: 'CUSTOMER', code: 'DETENTION', calculatedBy: 'FLAT', rateCents: 7_500, isRate: false, sortOrder: 2 },
]

const sellQuote: QuoteRecord = {
  id: 'Q000012',
  side: 'SELL',
  status: 'QUOTED',
  quoteDate: '2026-03-17',
  quoteMonth: '2026-03',
  customerId: 'cust-7788',
  customerName: CUSTOMER_NAME,
  contactName: 'Dana Reed',
  contactEmail: 'Dana@Globex.example',
  carrierName: 'Hauler Bros Trucking',
  carrierEmail: 'dispatch@haulerbros.example',
  mode: 'FTL',
  equipmentType: 'Dry Van',
  equipmentLengthFt: 53,
  stops,
  commodity: 'Paper',
  weightLbs: 42_000,
  miles: 412,
  lines,
  amountCents: 145_500,
  customerRateCents: 145_500,
  targetBuyCents: 777_111,
  topSpendCents: 919_191,
  marginBps: 3_337,
  rounds: 1,
  expiresAt: '2026-03-19T15:00:00.000Z',
  sentAt: '2026-03-17T15:00:00.000Z',
  customerMessage: 'Rate includes two hours free at each stop.',
  internalNotes: INTERNAL_NOTES,
  createdBy: 'rep@bcat.example',
  updatedBy: 'rep@bcat.example',
  version: 2,
}

const offerQuote: QuoteRecord = {
  ...sellQuote,
  id: 'Q000013',
  side: 'BUY',
  status: 'RECEIVED_COUNTER',
  contactName: 'Bud Kane',
  contactEmail: 'bud@haulerbros.example',
  amountCents: 120_000,
  counterCents: 128_000,
  counterBy: 'THEM',
  bookNowRateCents: 125_000,
  customerMessage: 'Tarps required. Driver must have a TWIC card.',
}

describe('the quote templates', () => {
  it('ships three templates that can all be answered', () => {
    for (const template of [
      DEFAULT_QUOTE_EMAIL_TEMPLATE,
      DEFAULT_COUNTER_EMAIL_TEMPLATE,
      DEFAULT_OFFER_REQUEST_EMAIL_TEMPLATE,
    ]) {
      expect(templateHasLink(template)).toBe(true)
      expect(quoteTemplateError(template)).toBeNull()
    }
  })

  it('refuses an operator template with no way back to us', () => {
    expect(quoteTemplateError('Our price is {amount}.')).toBe('The quote e-mail template needs a {link} token')
    expect(quoteTemplateError(null)).toBeNull()
    expect(quoteTemplateError('   ')).toBeNull()
  })
})

describe('renderQuoteEmail', () => {
  const { subject, body } = renderQuoteEmail({
    quote: sellQuote,
    link: LINK,
    brokerName: BROKER,
    termsText: TERMS,
    nowIso: NOW,
  })

  it('reads as a finished e-mail an operator could send by hand', () => {
    expect(subject).toContain('Q000012')
    expect(subject).toContain('1455.00')
    expect(body).toContain('Dana Reed,')
    expect(body).toContain(LINK)
    expect(body).toContain('Line haul: $1200.00')
    expect(body).toContain('Fuel surcharge: $180.00')
    expect(body).toContain('Total: $1455.00')
    expect(body).toContain('Chicago, IL')
    expect(body).toContain('Danville, IL')
    expect(body).toContain('2026-03-19 15:00 UTC')
    expect(body).toContain(TERMS)
    expect(body.trimEnd().endsWith(BROKER)).toBe(true)
  })

  it('tells a customer nothing about what the freight costs us', () => {
    for (const [field, value] of Object.entries({
      targetBuyCents: '7771.11',
      topSpendCents: '9191.91',
      marginBps: '3337',
      internalNotes: INTERNAL_NOTES,
      carrierName: 'Hauler Bros Trucking',
      carrierEmail: 'dispatch@haulerbros.example',
      facility: 'Acme Dock 7',
      street: '4400 Internal Way',
    })) {
      expect(body, `quote e-mail leaked ${field}`).not.toContain(value)
    }
  })

  it('fills the operator’s own template in', () => {
    const { body: custom } = renderQuoteEmail({
      quote: sellQuote,
      link: LINK,
      brokerName: BROKER,
      template: 'Quote {number}: {lane} for {amount}. Answer at {link} before {expires}.',
      nowIso: NOW,
    })
    expect(custom).toContain('Quote Q000012: Chicago, IL to Danville, IL for $1455.00.')
    expect(custom).toContain(`Answer at ${LINK} before 2026-03-19 15:00 UTC.`)
  })

  it('falls back to the default rather than send a quote nobody can answer', () => {
    const { body: fallback } = renderQuoteEmail({
      quote: sellQuote,
      link: LINK,
      brokerName: BROKER,
      template: 'Our price is {amount}.',
      nowIso: NOW,
    })
    expect(fallback).toContain(LINK)
  })
})

describe('renderCounterEmail', () => {
  it('puts our new number and a live link in front of them again', () => {
    const { subject, body } = renderCounterEmail({
      quote: { ...sellQuote, status: 'SENT_COUNTER', amountCents: 139_900, rounds: 2 },
      link: LINK,
      brokerName: BROKER,
      termsText: TERMS,
      nowIso: NOW,
    })
    expect(subject).toContain('Q000012')
    expect(subject).toContain('1399.00')
    expect(body).toContain('Total: $1399.00')
    expect(body).toContain(LINK)
    expect(body).toContain(TERMS)
  })
})

describe('renderOfferRequestEmail', () => {
  const { subject, body } = renderOfferRequestEmail({
    quote: offerQuote,
    link: LINK,
    brokerName: BROKER,
    bookNowRateCents: 125_000,
    nowIso: NOW,
  })

  it('asks the carrier for a truck at our number', () => {
    expect(subject).toContain('Chicago, IL to Danville, IL')
    expect(body).toContain('Our offer: $1200.00')
    expect(body).toContain('Book it now at $1250.00.')
    expect(body).toContain('Your last number: $1280.00')
    expect(body).toContain('Chicago, IL')
    expect(body).toContain(LINK)
  })

  it('never tells a carrier whose freight it is or what it sold for', () => {
    for (const [field, value] of Object.entries({
      customerName: CUSTOMER_NAME,
      customerId: 'cust-7788',
      customerRate: '1455.00',
      customerRateCents: '145500',
      marginBps: '3337',
      targetBuyCents: '7771.11',
      internalNotes: INTERNAL_NOTES,
      lineLabel: 'Line haul',
    })) {
      expect(`${subject}\n${body}`, `offer e-mail leaked ${field}`).not.toContain(value)
    }
  })

  it('keeps the book-now number out of it until the org switches it on', () => {
    const { body: quiet } = renderOfferRequestEmail({
      quote: offerQuote,
      link: LINK,
      brokerName: BROKER,
      nowIso: NOW,
    })
    expect(quiet).not.toContain('1250.00')
    expect(quiet).toContain('Our offer: $1200.00')
    expect(quiet).toContain(LINK)
  })
})

describe('quoteRecipients', () => {
  it('writes to the person the quote was written for first', () => {
    expect(
      quoteRecipients(sellQuote, [
        { email: 'Sales@Globex.example', types: ['SALES'] },
        { email: 'ap@globex.example', types: ['BILLING'] },
      ]),
    ).toEqual(['dana@globex.example', 'sales@globex.example'])
  })

  it('falls back to the customer’s sales and primary people, in that order', () => {
    expect(
      quoteRecipients({ contactEmail: null }, [
        { email: 'owner@globex.example', types: ['PRIMARY'] },
        { email: 'sales@globex.example', type: 'SALES' },
        { email: 'claims@globex.example', types: ['CLAIMS'] },
      ]),
    ).toEqual(['sales@globex.example', 'owner@globex.example'])
  })

  it('sends nothing to a blank, a duplicate or somebody who has left', () => {
    expect(
      quoteRecipients({ contactEmail: '  ' }, [
        { email: '', types: ['SALES'] },
        { email: 'sales@globex.example', types: ['SALES'] },
        { email: 'SALES@globex.example', types: ['PRIMARY'] },
        { email: 'gone@globex.example', types: ['SALES'], active: false },
      ]),
    ).toEqual(['sales@globex.example'])
  })

  it('answers with nothing rather than guess when nobody is listed', () => {
    expect(quoteRecipients({ contactEmail: null }, null)).toEqual([])
  })
})
