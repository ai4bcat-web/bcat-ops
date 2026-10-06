/**
 * Read a tender email well enough to start building the load from it.
 *
 * Intake items arrive as forwarded tender emails, and the fields a dispatcher then types
 * into the load drawer are already sitting in the body — reference numbers, both facilities
 * with full street addresses, and the planned dates. Re-typing them is both slow and the
 * main source of the missing ZIPs and customer names that later stall the factoring queue.
 *
 * Two shapes are read, because between them they cover every tender with real detail in it:
 *
 *   E2OPEN   the "Load Report" tenders (Batory and the other e2open shippers). Structured,
 *            machine-generated, and complete: Ref #, Shipper, Shipments, a Pick and a Drop
 *            block each with a full address and a Plan date. 132 of the 391 Ivan items.
 *   SUBJECT  the subject line alone, which carries a reference, both city/state pairs and
 *            often the customer. Weaker, but it is all a Schneider rate confirmation or a
 *            bare forward gives us, and city/state still beats an empty form.
 *
 * Deliberately NOT an extractor for everything. Anything it cannot read with confidence it
 * leaves alone: a wrong ZIP silently attached to a load is worse than a blank one, because
 * the blank is the thing the queue already knows how to complain about. Every field is
 * independently optional, and `format: null` means "nothing worth prefilling".
 *
 * Pure string work, no network, no dates relative to now — so it is fully testable and the
 * same email always yields the same prefill.
 */

import { findCustomerMatches } from './tmsDirectory'
import type { CustomerRecord } from '../types/tms'

export interface TenderStopPrefill {
  type: 'pickup' | 'delivery'
  name?: string
  street?: string
  city?: string
  state?: string
  zip?: string
  /** Planned date as `YYYY-MM-DD`. Never a time: see the note in parsePlanDate. */
  dateStr?: string
  /**
   * `HH:mm` of a BOOKED appointment, from the tender's Appt line.
   *
   * Only ever set when the tender states a real one. The Plan line carries 00:00 on every
   * one of the 166 tenders on file — it is a placeholder for "no appointment yet", and
   * writing midnight into a stop would read as a time somebody booked.
   */
  time?: string
  /** Facility instructions — appointment rules, sealing, notice periods. */
  instructions?: string
}

export interface TenderPrefill {
  format: 'E2OPEN' | 'SUBJECT' | null
  /*
   * Set only when the broker name matched a directory customer EXACTLY. Its presence is
   * what lets the load carry an MC into the factoring queue; its absence means a human
   * still has to pick the customer, which is the correct outcome for an unknown broker.
   */
  customerId?: string
  /*
   * S3 key of the rate confirmation that came in on the tender, when one did.
   *
   * Pointed at rather than copied when the load is built: it is already in the same bucket
   * and readable, and a second copy would be one more thing to keep in step.
   */
  rateConKey?: string
  /** The reference a dispatcher would put in Pro # — TMS ID or Route #. */
  reference?: string
  /** Shipment / SO number, which is the PU#. */
  pickupNumber?: string
  customer?: string
  weightLb?: number
  stops: TenderStopPrefill[]
}

const EMPTY: TenderPrefill = { format: null, stops: [] }

function clean(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/*
 * Street-type words, used only to find where an address ends and the city begins.
 *
 * The address line runs the facility name, the street and the city together with no
 * separator — "BATORY'S OAKLEY CHICAGO 2234 W 43RD STREET CHICAGO , IL 60609" — and the
 * city name genuinely appears twice there. Splitting on the last street-type word is what
 * makes "CHICAGO" the city rather than part of the street, and it is why a multi-word city
 * like ELK GROVE VILLAGE survives.
 */
const STREET_TYPES =
  /\b(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|WAY|CT|COURT|PL|PLACE|PKWY|PARKWAY|HWY|HIGHWAY|CIR|CIRCLE|TER|TERRACE|TRL|TRAIL|SQ|SQUARE|LOOP|LOT|LOTS|LVD|LVL|EXPY|EXPRESSWAY|LANES|LN\.|RT|ROUTE)\b/gi

/**
 * One e2open address line → name / street / city / state / zip.
 *
 * Anchored on the `, ST 60609` tail, which is the only reliably delimited part. Everything
 * before it is split on the last street-type word; with no street-type word to go on, the
 * last single word before the comma is taken as the city and nothing is claimed as a street
 * — a guess at where a street starts is not worth a wrong address.
 */
export function parseAddressLine(line: string): Omit<TenderStopPrefill, 'type' | 'dateStr'> {
  const text = clean(line)
  const tail = text.match(/^(.*?)\s*,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/i)
  if (!tail) return {}
  const [, head, state, zip] = tail

  let name = ''
  let street = ''
  let city: string

  const types = [...head.matchAll(STREET_TYPES)]
  const last = types[types.length - 1]
  if (last && last.index != null) {
    const end = last.index + last[0].length
    city = clean(head.slice(end))
    const beforeCity = clean(head.slice(0, end))
    // The street starts at the house number; what precedes it is the facility name.
    const split = beforeCity.match(/^(.*?)\s(\d+\s.*)$/)
    if (split) {
      name = clean(split[1])
      street = clean(split[2])
    } else {
      street = beforeCity
    }
  } else {
    const words = head.split(' ')
    city = clean(words.pop())
    name = clean(words.join(' '))
  }

  // A city that came out empty means the split was wrong; claim neither it nor the street.
  if (!city) return { name: clean(head), state: state.toUpperCase(), zip }

  return {
    ...(name ? { name } : {}),
    ...(street ? { street } : {}),
    city,
    state: state.toUpperCase(),
    zip,
  }
}

/**
 * `Plan: 08/04/2026 00:00 CDT - ...` → `2026-08-04`.
 *
 * The date only, never the time. These tenders carry 00:00 as a placeholder for "no
 * appointment yet", and writing midnight into a stop would read as a confirmed appointment
 * nobody made — the same reason emptyStopForms sets a date with no time.
 */
export function parsePlanDate(line: string): string | undefined {
  const m = clean(line).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return undefined
  const [, mm, dd, yyyy] = m
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

/** The e2open "Load Report" tender — the one format that carries everything. */
/**
 * `Appt: 06/17/2026 08:00 CDT - ...` -> `{ dateStr, time }`, or null when it reads `--`.
 *
 * This is the BOOKED appointment, and the only place in a tender a real time appears. 20 of
 * the 166 tenders on file carry one; the rest say `--`, meaning it is still to be made.
 */
export function parseApptLine(line: string): { dateStr: string; time?: string } | null {
  const m = clean(line).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (!m) return null
  const [, mm, dd, yyyy, hh, mi] = m
  const dateStr = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  // Midnight means here what it means on the Plan line: not actually booked.
  if (!hh || (hh === '00' && mi === '00')) return { dateStr }
  return { dateStr, time: `${hh.padStart(2, '0')}:${mi}` }
}

function parseE2open(body: string): TenderPrefill | null {
  if (!/Load Report/i.test(body)) return null

  const out: TenderPrefill = { format: 'E2OPEN', stops: [] }

  const ref = body.match(/Ref\s*#\s*:\s*(?:TMS\s*ID\s*)?(\d{5,12})/i)
  if (ref) out.reference = ref[1]

  const shipment = body.match(/Shipments?\s*:\s*(\S+)/i)
  if (shipment) out.pickupNumber = shipment[1]

  const shipper = body.match(/^\s*Shipper\s*:\s*(.+)$/im)
  if (shipper) out.customer = clean(shipper[1])

  const weight = body.match(/Weight\s*:\s*([\d,]+(?:\.\d+)?)\s*lb/i)
  if (weight) {
    const n = Number(weight[1].replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0) out.weightLb = Math.round(n)
  }

  /*
   * Stops are `-----` delimited blocks whose first line is Pick or Drop. Read in document
   * order so a multi-stop tender keeps its sequence, and every Pick/Drop is taken — not
   * just the first of each — because the route is what it says it is.
   */
  for (const block of body.split(/^-{5,}\s*$/m)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const kind = /^(Pick|Drop)\b/i.exec(lines[0])
    if (!kind) continue
    const type = /^pick/i.test(kind[1]) ? 'pickup' : 'delivery'

    // The address is the first line after the header that ends in `, ST ZIP`.
    const addrLine = lines.slice(1).find((l) => /,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i.test(l))
    const plan = lines.find((l) => /^Plan\s*:/i.test(l))

    const stop: TenderStopPrefill = { type }
    if (addrLine) Object.assign(stop, parseAddressLine(addrLine))

    /*
     * A booked Appt wins over the planned date. Plan is when the shipper wants it; Appt is
     * what was actually agreed, and it is the only line that carries a real time.
     */
    const apptLine = lines.find((l) => /^Appt\s*:/i.test(l))
    const booked = apptLine ? parseApptLine(apptLine) : null
    const dateStr = booked?.dateStr ?? (plan ? parsePlanDate(plan) : undefined)
    if (dateStr) stop.dateStr = dateStr
    if (booked?.time) stop.time = booked.time

    /*
     * Facility instructions — "Appointments required", "48 Hour Notice", "must be locked or
     * sealed". 162 of the 166 tenders carry one, and it is the thing a dispatcher otherwise
     * reads off the email and retypes.
     */
    const instructionLines = lines
      .filter((l) => /^Instructions\s*:/i.test(l))
      .map((l) => clean(l.replace(/^Instructions\s*:/i, '')))
      .filter(Boolean)
    if (instructionLines.length) stop.instructions = instructionLines.join(' · ')

    // A header with none of these tells us nothing worth prefilling.
    if (addrLine || dateStr || stop.instructions) out.stops.push(stop)
  }

  return out
}

/**
 * The subject line, for everything else.
 *
 * Two shapes in practice, and both end with the same `CITY, ST to CITY, ST` pair:
 *   Tender TMS ID 208663813: CHICAGO, IL(08/04) to WAUKEGAN, IL by BATORY FOODS
 *   Rate Confirmation for Route # 4010756658 - MESA, AZ – Tempe, AZ
 * No ZIPs and no year, so this yields city/state and a reference — enough to save typing
 * and to tell the dispatcher they are on the right load, not enough to satisfy factoring.
 */
function parseSubject(subject: string): TenderPrefill | null {
  const text = clean(subject)
  if (!text) return null

  const out: TenderPrefill = { format: 'SUBJECT', stops: [] }

  /*
   * "Rate Confirmation for 3650024" is included because several brokers — Axle, M2 — send
   * nothing but an acceptance notice with that one line in it. The number is theirs, not an
   * Aljex PRO, so it lands in TMS ID like every other tender reference.
   */
  const ref = text.match(
    /(?:TMS\s*ID|Route\s*#|Order\s*#|Load\s*#|Rate\s*Confirmation\s+for)\s*:?\s*#?\s*(\d{5,12})/i,
  )
  if (ref) out.reference = ref[1]

  const by = text.match(/\bby\s+([A-Z][A-Z0-9&'.\- ]{2,})\s*$/)
  if (by) out.customer = clean(by[1])

  /*
   * "Axle Logistics, LLC Rate Confirmation for 3650024" — the broker names itself before
   * the phrase. Only taken when it is not already known from a "by X" suffix, and only up
   * to the phrase, so a forwarding prefix like "Fwd:" never becomes part of the name.
   */
  if (!out.customer) {
    const before = text.match(/(?:^|:\s*)([A-Za-z][A-Za-z0-9&'.,\- ]{2,}?)\s+Rate\s*Confirmation\s+for\b/i)
    if (before) out.customer = clean(before[1])
  }

  // `CITY, ST` twice, separated by "to", a dash or an en dash.
  const pair = text.match(
    /([A-Za-z][A-Za-z.' ]+?)\s*,\s*([A-Z]{2})\b[^A-Za-z]*(?:to|[-–—])[^A-Za-z]*([A-Za-z][A-Za-z.' ]+?)\s*,\s*([A-Z]{2})\b/,
  )
  if (pair) {
    out.stops.push({ type: 'pickup', city: clean(pair[1]), state: pair[2].toUpperCase() })
    out.stops.push({ type: 'delivery', city: clean(pair[3]), state: pair[4].toUpperCase() })
  }

  if (!out.reference && !out.stops.length && !out.customer) return null
  return out
}

/**
 * Everything worth prefilling from one intake item.
 *
 * The structured body wins when there is one; the subject is the fallback. They are not
 * merged — a half-read body plus a subject guess is how fields end up disagreeing with
 * each other, and the body already carries strictly more than the subject when present.
 */
export function parseTender(subject: string | null | undefined, bodyText: string | null | undefined): TenderPrefill {
  const body = bodyText ?? ''
  const fromBody = body ? parseE2open(body) : null
  if (fromBody && (fromBody.reference || fromBody.stops.length)) return fromBody
  return parseSubject(subject ?? '') ?? EMPTY
}


/**
 * The directory customer a tender's broker name refers to, when there is no doubt.
 *
 * Binding the customer is what carries the MC number into the factoring queue, and the MC
 * decides who gets billed — so only an EXACT name or alias match counts. findCustomerMatches
 * also returns near misses for a human to review; those are deliberately refused here,
 * because "similar name" is not a basis for choosing whose MC goes on an invoice.
 *
 * Returning the record rather than the parsed string is the point: the name that lands on
 * the load is then the directory's own, never free text read off an email.
 */
export function resolveTenderCustomer(
  name: string | null | undefined,
  customers: CustomerRecord[],
): CustomerRecord | null {
  if (!name?.trim()) return null
  const exact = findCustomerMatches(name, customers).filter((m) => m.score === 1)
  // Two records sharing a name is a directory problem; picking one here would hide it.
  return exact.length === 1 ? exact[0].record : null
}
