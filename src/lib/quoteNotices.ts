/**
 * The e-mails a quote and an offer go out in.
 *
 * Every body is built from `quotePublicView`, never from the Quote row: the rule
 * about what a customer may see and what a carrier may see is written once, in
 * `quotes.ts`, and these functions inherit it. A quote e-mail therefore cannot
 * carry a margin or a target buy, and an offer e-mail cannot carry the customer's
 * name or the customer's rate, however this file is edited later.
 *
 * They are plain text on purpose. SES is denied on dev, so the body an operator
 * copies out of the UI and pastes into Outlook has to read as a finished e-mail —
 * including the link, which is the only way the other side can answer.
 *
 * Imports are relative: `tmsShipmentActions` bundles this file by path and the
 * `@/` alias does not exist in the function build.
 */
import { quotePublicView } from './quotes'
import { MAX_NOTICE_BODY_CHARS } from './shipmentNotices'
import { formatCents } from './tmsDirectory'
import type { QuotePublicStop, QuotePublicView, QuoteRecord } from '../types/tms'

/** The quote that goes out with our number on it. Must carry `{link}`. */
export const DEFAULT_QUOTE_EMAIL_TEMPLATE =
  'Here is our quote {number} for {lane} at {amount}.\n\nAccept it, counter it or decline it here: {link}'

/** What we send when we answer their counter with one of our own. Must carry `{link}`. */
export const DEFAULT_COUNTER_EMAIL_TEMPLATE =
  'Thanks for coming back to us on quote {number}. We can do {lane} at {amount}.\n\nAccept it, counter it or decline it here: {link}'

/** What a carrier gets when we are looking for a truck. Must carry `{link}`. */
export const DEFAULT_OFFER_REQUEST_EMAIL_TEMPLATE =
  'We have a load going {lane}, picking up {pickup}, and we are offering {amount}.\n\nTake it, name your price or pass here: {link}'

const QUOTE_TEMPLATE_MESSAGE = 'The quote e-mail template needs a {link} token'

/** A template that cannot carry the link cannot be answered. */
export function templateHasLink(template: string | null | undefined): boolean {
  return typeof template === 'string' && template.includes('{link}')
}

/**
 * The settings card and the send action refuse through the same function, so they
 * refuse alike. A blank template is not an error: it means the default.
 */
export function quoteTemplateError(template: string | null | undefined): string | null {
  const chosen = template?.trim()
  if (!chosen) return null
  return templateHasLink(chosen) ? null : QUOTE_TEMPLATE_MESSAGE
}

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** `2026-03-18T15:00:00.000Z` as `2026-03-18 15:00 UTC` — readable, still unambiguous. */
function whenText(iso: string | null | undefined): string {
  if (!iso) return ''
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`.trim()
}

function placeText(stop: QuotePublicStop | undefined): string {
  if (!stop) return ''
  return [stop.city, stop.state].filter(Boolean).join(', ')
}

function laneText(view: QuotePublicView): string {
  const pickup = view.stops.find((stop) => stop.type === 'pickup') ?? view.stops[0]
  const delivery =
    [...view.stops].reverse().find((stop) => stop.type === 'delivery') ??
    view.stops[view.stops.length - 1]
  const from = placeText(pickup)
  const to = placeText(delivery)
  if (from && to && from !== to) return `${from} to ${to}`
  return from || to || 'this lane'
}

/** The freight block both sides get: where, when, on what, how heavy, how far. */
function freightLines(view: QuotePublicView): string[] {
  const lines: string[] = []
  const pickup = view.stops.find((stop) => stop.type === 'pickup') ?? view.stops[0]
  const delivery =
    [...view.stops].reverse().find((stop) => stop.type === 'delivery') ??
    (view.stops.length > 1 ? view.stops[view.stops.length - 1] : undefined)

  if (pickup) {
    const at = whenText(pickup.appt)
    lines.push(`Pickup: ${placeText(pickup)}${at ? ` — ${at}` : ''}`)
  }
  if (delivery && delivery !== pickup) {
    const at = whenText(delivery.appt)
    lines.push(`Delivery: ${placeText(delivery)}${at ? ` — ${at}` : ''}`)
  }

  const equipment = [view.equipmentType, view.equipmentLengthFt ? `${view.equipmentLengthFt} ft` : '']
    .filter(Boolean)
    .join(' ')
  if (equipment) lines.push(`Equipment: ${equipment}`)

  const freight = [
    view.commodity ?? '',
    view.weightLbs ? `${view.weightLbs.toLocaleString('en-US')} lb` : '',
    view.miles ? `${view.miles.toLocaleString('en-US')} mi` : '',
  ].filter(Boolean)
  if (freight.length > 0) lines.push(freight.join(', '))

  return lines
}

function finish(lines: string[]): string {
  return lines.join('\n').slice(0, MAX_NOTICE_BODY_CHARS)
}

export interface QuoteEmailInput {
  quote: QuoteRecord
  link: string
  brokerName: string
  template?: string | null
  termsText?: string | null
  /** Only reaches the view's `generatedAt`; the body never prints it. */
  nowIso?: string
}

export interface OfferRequestEmailInput {
  quote: QuoteRecord
  link: string
  brokerName: string
  template?: string | null
  /** Set only when the org lets a carrier book itself at a number. */
  bookNowRateCents?: number | null
  nowIso?: string
}

/**
 * The projection every body is built from. `nowIso` only reaches `generatedAt` and
 * the expiry flag, neither of which an e-mail prints, so a caller that has no clock
 * handy may leave it out and still get the same words.
 */
function viewFor(
  quote: QuoteRecord,
  brokerName: string,
  termsText: string | null,
  showBookNow: boolean,
  nowIso: string | undefined,
): QuotePublicView {
  return quotePublicView(quote, {
    brokerName,
    termsText,
    showBookNow,
    nowIso: nowIso ?? quote.sentAt ?? quote.updatedAt ?? quote.quoteDate,
  })
}

/** The sell-side body both the quote and the counter share, down to the signature. */
function sellBody(
  input: QuoteEmailInput,
  view: QuotePublicView,
  template: string,
  amount: string,
): string {
  const lines: string[] = []
  lines.push(input.quote.contactName?.trim() ? `${input.quote.contactName.trim()},` : 'Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      number: view.quoteNumber,
      amount,
      lane: laneText(view),
      link: input.link,
      broker: view.brokerName,
      expires: whenText(view.expiresAt),
      pickup: whenText(view.stops.find((stop) => stop.type === 'pickup')?.appt ?? null),
    }),
  )

  const freight = freightLines(view)
  if (freight.length > 0) {
    lines.push('')
    lines.push(...freight)
  }

  if (view.lines.length > 0) {
    lines.push('')
    for (const line of view.lines) lines.push(`${line.label}: $${formatCents(line.amountCents)}`)
  }
  lines.push('')
  lines.push(`Total: ${amount}`)

  if (view.message) {
    lines.push('')
    lines.push(view.message)
  }

  if (view.expiresAt) {
    lines.push('')
    lines.push(`This quote holds until ${whenText(view.expiresAt)}.`)
  }

  if (view.terms) {
    lines.push('')
    lines.push(view.terms)
  }

  lines.push('')
  lines.push(view.brokerName)
  return finish(lines)
}

/** Our number, with the lines behind it and the link that answers it. */
export function renderQuoteEmail(input: QuoteEmailInput): { subject: string; body: string } {
  const view = viewFor(input.quote, input.brokerName, input.termsText ?? null, false, input.nowIso)
  const amount = `$${formatCents(view.amountCents)}`
  const template = templateHasLink(input.template)
    ? (input.template as string)
    : DEFAULT_QUOTE_EMAIL_TEMPLATE
  return {
    subject: `Quote ${view.quoteNumber} — ${laneText(view)} — ${amount}`,
    body: sellBody(input, view, template, amount),
  }
}

/** The same e-mail one round later: our answer to their counter. */
export function renderCounterEmail(input: QuoteEmailInput): { subject: string; body: string } {
  const view = viewFor(input.quote, input.brokerName, input.termsText ?? null, false, input.nowIso)
  const amount = `$${formatCents(view.amountCents)}`
  const template = templateHasLink(input.template)
    ? (input.template as string)
    : DEFAULT_COUNTER_EMAIL_TEMPLATE
  return {
    subject: `Quote ${view.quoteNumber} — our counter at ${amount}`,
    body: sellBody(input, view, template, amount),
  }
}

/**
 * What a carrier is asked. It names the lane, the equipment and our money, and it
 * is built from the BUY view, which has no customer on it at all — the carrier
 * never learns whose freight it is or what it sold for.
 */
export function renderOfferRequestEmail(
  input: OfferRequestEmailInput,
): { subject: string; body: string } {
  const bookNowRateCents = input.bookNowRateCents ?? null
  const view = viewFor(input.quote, input.brokerName, null, bookNowRateCents != null, input.nowIso)
  const amount = `$${formatCents(view.amountCents)}`
  const template = templateHasLink(input.template)
    ? (input.template as string)
    : DEFAULT_OFFER_REQUEST_EMAIL_TEMPLATE
  const pickupAppt = view.stops.find((stop) => stop.type === 'pickup')?.appt ?? null

  const lines: string[] = []
  lines.push(input.quote.carrierName?.trim() ? `${input.quote.carrierName.trim()},` : 'Hello,')
  lines.push('')
  lines.push(
    applyTemplate(template, {
      number: view.quoteNumber,
      amount,
      lane: laneText(view),
      link: input.link,
      broker: view.brokerName,
      expires: whenText(view.expiresAt),
      pickup: whenText(pickupAppt),
    }),
  )

  const freight = freightLines(view)
  if (freight.length > 0) {
    lines.push('')
    lines.push(...freight)
  }

  lines.push('')
  lines.push(`Our offer: ${amount}`)
  const bookNow = bookNowRateCents ?? view.bookNowRateCents ?? null
  if (bookNow != null) lines.push(`Book it now at $${formatCents(bookNow)}.`)
  if (view.theirAmountCents != null) {
    lines.push(`Your last number: $${formatCents(view.theirAmountCents)}`)
  }

  if (view.message) {
    lines.push('')
    lines.push(view.message)
  }

  if (view.expiresAt) {
    lines.push('')
    lines.push(`This offer holds until ${whenText(view.expiresAt)}.`)
  }

  if (view.terms) {
    lines.push('')
    lines.push(view.terms)
  }

  lines.push('')
  lines.push(view.brokerName)

  return {
    subject: `Load available — ${laneText(view)} — ${amount}`,
    body: finish(lines),
  }
}

/** A contact as this function needs it; `CustomerContact` fits without conversion. */
export interface QuoteContactInput {
  email?: string | null
  type?: string | null
  types?: readonly string[] | null
  active?: boolean | null
}

/**
 * Where a quote is sent: the person it was written for first, then the customer's
 * sales and primary contacts. Billing and claims people are not quoted to — they
 * hear about the freight after it exists. Empty is a normal answer and an honest
 * one: a caller that gets nothing back has to say so rather than send to nobody.
 */
export function quoteRecipients(
  quote: Pick<QuoteRecord, 'contactEmail'>,
  customerContacts: QuoteContactInput[] | null,
): string[] {
  const out: string[] = []
  const add = (value: string | null | undefined): void => {
    const email = (value ?? '').trim().toLowerCase()
    if (!email.includes('@') || out.includes(email)) return
    out.push(email)
  }

  add(quote.contactEmail)
  for (const wanted of ['SALES', 'PRIMARY']) {
    for (const contact of customerContacts ?? []) {
      if (contact.active === false) continue
      const types = contact.types ?? (contact.type ? [contact.type] : [])
      if (!types.some((type) => (type ?? '').trim().toUpperCase() === wanted)) continue
      add(contact.email)
    }
  }
  return out
}
