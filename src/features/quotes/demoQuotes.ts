/**
 * *** FABRICATED DEMO DATA — NOT REAL CUSTOMERS, QUOTES, RATES OR E-MAILS. ***
 *
 * Every customer, contact, address, lane, rate and conversation in this file was invented
 * to demonstrate the "Customers" view of the Quotes page (what an e-mail negotiator thread
 * looks like, and how a customer's quote history rolls up). Nothing here is read from or
 * written to any API, table or mailbox, and none of it is mixed into the real quotes list.
 * E-mail addresses use the reserved example.com domain.
 *
 * Totals are never stored: `customerStats()` derives received / won / rates / dollars from
 * the quote rows below, so the numbers on screen cannot drift from the rows.
 */

export type DemoOutcome = 'won' | 'lost' | 'pending' | 'expired'

export const DEMO_TARGET_MARGIN_PCT = 12

export interface DemoCustomer {
  id: string
  name: string
  kind: 'Shipper' | 'Broker'
  contact: string
  email: string
}

export interface DemoQuote {
  id: string
  customerId: string
  /** `YYYY-MM-DD`, the day the request came in. */
  date: string
  origin: string
  destination: string
  equipment: string
  miles: number
  /** What our agent quoted, in cents. */
  quotedCents: number
  /** What was actually agreed, in cents (won only; differs from quoted after a counter). */
  finalCents: number | null
  outcome: DemoOutcome
  /** The competing price, when the customer told us (lost only). */
  competitorCents: number | null
  /** Our cost to cover the load, in cents. */
  costCents: number
  /** Minutes from the request landing to our first reply. */
  minutesToQuote: number
}

export interface DemoMessage {
  id: string
  role: 'customer' | 'agent' | 'sales'
  from: string
  /** ISO timestamp (UTC). */
  at: string
  subject?: string
  body: string
  /** A rate stated in this message, in cents; highlighted in the thread. */
  rateCents?: number
}

export const DEMO_CUSTOMERS: DemoCustomer[] = [
  { id: 'c-midwest', name: 'Midwest Packaging Co.', kind: 'Shipper', contact: 'Tara Lindqvist', email: 'tara.lindqvist@midwestpackaging.example.com' },
  { id: 'c-lakeshore', name: 'Lakeshore Logistics Brokerage', kind: 'Broker', contact: 'Devon Marsh', email: 'devon@lakeshorelogistics.example.com' },
  { id: 'c-redline', name: 'Redline Freight Brokers', kind: 'Broker', contact: 'Priya Natarajan', email: 'priya@redlinefreight.example.com' },
  { id: 'c-prairie', name: 'Prairie Foods Distribution', kind: 'Shipper', contact: 'Hank Olafson', email: 'hank.olafson@prairiefoods.example.com' },
  { id: 'c-summit', name: 'Summit Building Supply', kind: 'Shipper', contact: 'Callie Burrows', email: 'callie@summitbuilding.example.com' },
  { id: 'c-harbor', name: 'Harbor Retail Group', kind: 'Shipper', contact: 'Jonah Feldman', email: 'jonah.feldman@harborretail.example.com' },
  { id: 'c-delta', name: 'Delta Steel & Fabrication', kind: 'Shipper', contact: 'Rosa Quintero', email: 'rquintero@deltasteel.example.com' },
]

type Row = [date: string, origin: string, destination: string, equipment: string, miles: number, rate: number, outcome: DemoOutcome, competitor?: number]

const ROWS: Record<string, Row[]> = {
  'c-midwest': [
    ['2026-08-12', 'Chicago, IL', 'Dallas, TX', 'Dry Van', 925, 2450, 'won'],
    ['2026-08-19', 'Chicago, IL', 'Atlanta, GA', 'Dry Van', 715, 1980, 'won'],
    ['2026-08-27', 'Joliet, IL', 'Columbus, OH', 'Dry Van', 345, 1050, 'lost', 980],
    ['2026-09-04', 'Chicago, IL', 'Memphis, TN', 'Dry Van', 530, 1520, 'won'],
    ['2026-09-15', 'Rockford, IL', 'Kansas City, MO', 'Dry Van', 485, 1390, 'won'],
    ['2026-09-24', 'Chicago, IL', 'Charlotte, NC', 'Dry Van', 770, 2140, 'won'],
    ['2026-10-06', 'Elk Grove Village, IL', 'Houston, TX', 'Dry Van', 1085, 2890, 'lost', 2760],
    ['2026-10-14', 'Chicago, IL', 'Nashville, TN', 'Dry Van', 470, 1360, 'won'],
    ['2026-10-27', 'Chicago, IL', 'Denver, CO', 'Dry Van', 1005, 2760, 'won'],
    ['2026-11-08', 'Chicago, IL', 'Minneapolis, MN', 'Dry Van', 410, 1240, 'pending'],
  ],
  'c-lakeshore': [
    ['2026-08-05', 'Indianapolis, IN', 'Newark, NJ', 'Dry Van', 720, 2090, 'lost', 1940],
    ['2026-08-11', 'Indianapolis, IN', 'Atlanta, GA', 'Dry Van', 530, 1610, 'won'],
    ['2026-08-20', 'Louisville, KY', 'Dallas, TX', 'Dry Van', 810, 2310, 'lost', 2150],
    ['2026-08-28', 'Cincinnati, OH', 'Philadelphia, PA', 'Dry Van', 575, 1740, 'lost', 1650],
    ['2026-09-03', 'Indianapolis, IN', 'Orlando, FL', 'Dry Van', 940, 2640, 'lost'],
    ['2026-09-12', 'Columbus, OH', 'Charlotte, NC', 'Dry Van', 460, 1420, 'won'],
    ['2026-09-19', 'Indianapolis, IN', 'Houston, TX', 'Dry Van', 1010, 2830, 'lost', 2640],
    ['2026-09-30', 'Louisville, KY', 'Chicago, IL', 'Dry Van', 300, 960, 'won'],
    ['2026-10-08', 'Cincinnati, OH', 'Atlanta, GA', 'Dry Van', 465, 1450, 'lost', 1370],
    ['2026-10-16', 'Indianapolis, IN', 'St. Louis, MO', 'Dry Van', 245, 840, 'won'],
    ['2026-10-29', 'Columbus, OH', 'Dallas, TX', 'Dry Van', 1010, 2900, 'expired'],
    ['2026-11-07', 'Indianapolis, IN', 'Memphis, TN', 'Dry Van', 465, 1390, 'pending'],
  ],
  'c-redline': [
    ['2026-08-09', 'Los Angeles, CA', 'Phoenix, AZ', 'Dry Van', 370, 1180, 'lost', 1050],
    ['2026-08-21', 'Los Angeles, CA', 'Las Vegas, NV', 'Dry Van', 270, 940, 'lost', 860],
    ['2026-09-02', 'Ontario, CA', 'Dallas, TX', 'Dry Van', 1435, 3640, 'lost', 3390],
    ['2026-09-11', 'Los Angeles, CA', 'Salt Lake City, UT', 'Dry Van', 690, 2020, 'won'],
    ['2026-09-22', 'Ontario, CA', 'Denver, CO', 'Dry Van', 1020, 2880, 'lost', 2700],
    ['2026-10-03', 'Los Angeles, CA', 'Phoenix, AZ', 'Dry Van', 370, 1210, 'lost'],
    ['2026-10-17', 'Fontana, CA', 'Seattle, WA', 'Dry Van', 1135, 3320, 'won'],
    ['2026-10-30', 'Los Angeles, CA', 'Portland, OR', 'Dry Van', 965, 2760, 'expired'],
  ],
  'c-prairie': [
    ['2026-08-14', 'Omaha, NE', 'Chicago, IL', 'Reefer', 465, 1760, 'won'],
    ['2026-09-01', 'Omaha, NE', 'Minneapolis, MN', 'Reefer', 380, 1520, 'won'],
    ['2026-09-18', 'Des Moines, IA', 'Dallas, TX', 'Reefer', 760, 2780, 'won'],
    ['2026-10-02', 'Omaha, NE', 'Denver, CO', 'Reefer', 540, 1980, 'lost', 1850],
    ['2026-10-20', 'Sioux Falls, SD', 'Chicago, IL', 'Reefer', 575, 2090, 'won'],
    ['2026-11-03', 'Omaha, NE', 'Kansas City, MO', 'Reefer', 190, 910, 'won'],
  ],
  'c-summit': [
    ['2026-08-07', 'Atlanta, GA', 'Nashville, TN', 'Flatbed', 250, 980, 'won'],
    ['2026-08-18', 'Atlanta, GA', 'Charlotte, NC', 'Flatbed', 245, 960, 'won'],
    ['2026-09-05', 'Birmingham, AL', 'Dallas, TX', 'Flatbed', 635, 2240, 'lost', 2100],
    ['2026-09-16', 'Atlanta, GA', 'Jacksonville, FL', 'Flatbed', 345, 1240, 'won'],
    ['2026-09-26', 'Atlanta, GA', 'Houston, TX', 'Flatbed', 790, 2680, 'lost', 2520],
    ['2026-10-09', 'Savannah, GA', 'Raleigh, NC', 'Flatbed', 390, 1380, 'won'],
    ['2026-10-21', 'Atlanta, GA', 'Memphis, TN', 'Flatbed', 380, 1330, 'lost', 1240],
    ['2026-11-02', 'Birmingham, AL', 'Atlanta, GA', 'Flatbed', 150, 720, 'won'],
    ['2026-11-09', 'Atlanta, GA', 'Tampa, FL', 'Flatbed', 460, 1560, 'pending'],
  ],
  'c-harbor': [
    ['2026-11-05', 'Newark, NJ', 'Chicago, IL', 'Dry Van', 790, 2230, 'pending'],
    ['2026-11-06', 'Newark, NJ', 'Atlanta, GA', 'Dry Van', 870, 2410, 'pending'],
    ['2026-11-07', 'Columbus, OH', 'Newark, NJ', 'Dry Van', 530, 1650, 'pending'],
    ['2026-11-09', 'Newark, NJ', 'Boston, MA', 'Dry Van', 215, 890, 'pending'],
    ['2026-11-10', 'Newark, NJ', 'Pittsburgh, PA', 'Dry Van', 365, 1190, 'pending'],
  ],
  'c-delta': [
    ['2026-08-13', 'Pittsburgh, PA', 'Houston, TX', 'Step Deck', 1370, 4480, 'won'],
    ['2026-08-29', 'Gary, IN', 'Detroit, MI', 'Flatbed', 285, 1120, 'lost', 1010],
    ['2026-09-10', 'Pittsburgh, PA', 'Chicago, IL', 'Flatbed', 465, 1650, 'won'],
    ['2026-09-25', 'Gary, IN', 'Dallas, TX', 'Step Deck', 960, 3380, 'lost', 3190],
    ['2026-10-07', 'Pittsburgh, PA', 'Birmingham, AL', 'Flatbed', 810, 2680, 'lost', 2510],
    ['2026-10-22', 'Gary, IN', 'Atlanta, GA', 'Flatbed', 640, 2210, 'won'],
    ['2026-10-31', 'Pittsburgh, PA', 'Charlotte, NC', 'Flatbed', 540, 1900, 'expired'],
  ],
}

/** Quotes whose agreed rate moved off the quoted one in a written thread below. */
const FINAL_OVERRIDES: Record<string, number> = {
  'DQ-1001': 239_000,
  'DQ-1040': 119_500,
}

function buildQuotes(): DemoQuote[] {
  const out: DemoQuote[] = []
  let n = 0
  for (const customer of DEMO_CUSTOMERS) {
    for (const [date, origin, destination, equipment, miles, rate, outcome, competitor] of ROWS[customer.id] ?? []) {
      const id = `DQ-${1001 + n}`
      const quotedCents = rate * 100
      // A deterministic 8–19 % cost spread, so margins vary but never change between renders.
      const costCents = Math.round(quotedCents * (1 - (8 + ((n * 37) % 12)) / 100))
      out.push({
        id,
        customerId: customer.id,
        date,
        origin,
        destination,
        equipment,
        miles,
        quotedCents,
        finalCents: outcome === 'won' ? FINAL_OVERRIDES[id] ?? quotedCents : null,
        outcome,
        competitorCents: outcome === 'lost' && competitor ? competitor * 100 : null,
        costCents,
        minutesToQuote: 4 + ((n * 7) % 19),
      })
      n += 1
    }
  }
  return out
}

export const DEMO_QUOTES: DemoQuote[] = buildQuotes()

export function demoCustomer(id: string): DemoCustomer | undefined {
  return DEMO_CUSTOMERS.find((c) => c.id === id)
}

export function quotesForCustomer(customerId: string): DemoQuote[] {
  return DEMO_QUOTES.filter((q) => q.customerId === customerId).sort((a, b) => b.date.localeCompare(a.date))
}

export interface CustomerStats {
  customer: DemoCustomer
  received: number
  won: number
  lost: number
  pending: number
  expired: number
  /** Won / received, 0..1. */
  winRate: number
  quotedCents: number
  wonCents: number
  lastQuoteDate: string
}

/** Every figure derived from the quote rows — nothing is stored. */
export function customerStats(customer: DemoCustomer, quotes: DemoQuote[] = DEMO_QUOTES): CustomerStats {
  const mine = quotes.filter((q) => q.customerId === customer.id)
  const count = (o: DemoOutcome) => mine.filter((q) => q.outcome === o).length
  const won = count('won')
  return {
    customer,
    received: mine.length,
    won,
    lost: count('lost'),
    pending: count('pending'),
    expired: count('expired'),
    winRate: mine.length === 0 ? 0 : won / mine.length,
    quotedCents: mine.reduce((sum, q) => sum + q.quotedCents, 0),
    wonCents: mine.filter((q) => q.outcome === 'won').reduce((sum, q) => sum + (q.finalCents ?? 0), 0),
    lastQuoteDate: mine.reduce((latest, q) => (q.date > latest ? q.date : latest), ''),
  }
}

export function allCustomerStats(): CustomerStats[] {
  return DEMO_CUSTOMERS.map((c) => customerStats(c))
}

export interface QuoteSummary {
  finalCents: number
  /** Margin at the final rate, as a percent of that rate. */
  marginPct: number
  vsTargetPts: number
  minutesToQuote: number
}

export function quoteSummary(q: DemoQuote): QuoteSummary {
  const finalCents = q.finalCents ?? q.quotedCents
  const marginPct = ((finalCents - q.costCents) / finalCents) * 100
  return {
    finalCents,
    marginPct,
    vsTargetPts: marginPct - DEMO_TARGET_MARGIN_PCT,
    minutesToQuote: minutesToFirstReply(threadFor(q)) ?? q.minutesToQuote,
  }
}

function minutesToFirstReply(thread: DemoMessage[]): number | null {
  const ask = thread.find((m) => m.role === 'customer')
  const reply = thread.find((m) => m.role === 'agent')
  if (!ask || !reply) return null
  return Math.round((Date.parse(reply.at) - Date.parse(ask.at)) / 60_000)
}

// ---------------------------------------------------------------------------------------
// Conversations. Four are written out by hand; every other quote gets a short generated one
// so that any row can be opened.

const AGENT = 'BCAT AI Quoting Agent <quotes@bcatcorp.example.com>'
const SALES = 'Marcus Ellery (BCAT Sales) <marcus@bcatcorp.example.com>'

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US')}`

const WRITTEN: Record<string, DemoMessage[]> = {
  // Won after a counter.
  'DQ-1001': [
    {
      id: 'm1', role: 'customer', from: 'Tara Lindqvist <tara.lindqvist@midwestpackaging.example.com>',
      at: '2026-08-12T14:05:00Z', subject: 'Quote request: Chicago, IL to Dallas, TX, 42,000 lb dry van',
      body: 'Hi team, I have a full truckload of corrugated flats ready Thursday morning at our Chicago plant, going to our Dallas DC. 42,000 lbs, 53\' dry van, drop and hook is fine. Can you send a rate today?',
    },
    {
      id: 'm2', role: 'agent', from: AGENT, at: '2026-08-12T14:09:00Z',
      body: 'Thanks Tara. Chicago, IL to Dallas, TX is 925 miles, 53\' dry van, pickup Thursday. Our all-in rate is below. It is good for 48 hours and includes fuel and a standard 2 hour load window.',
      rateCents: 245_000,
    },
    {
      id: 'm3', role: 'customer', from: 'Tara Lindqvist <tara.lindqvist@midwestpackaging.example.com>', at: '2026-08-12T15:40:00Z',
      body: 'That is a little above what we paid last month on this lane. If you can get to $2,300 I can award you this one and the next two this month.',
      rateCents: 230_000,
    },
    {
      id: 'm4', role: 'sales', from: SALES, at: '2026-08-12T16:02:00Z',
      body: 'Tara, appreciate the volume. Fuel is up on the Dallas side this week, so $2,300 is under where we can cover it. I can do $2,390 all-in and keep the same pickup window, with the next two loads held at that rate.',
      rateCents: 239_000,
    },
    {
      id: 'm5', role: 'customer', from: 'Tara Lindqvist <tara.lindqvist@midwestpackaging.example.com>', at: '2026-08-12T16:21:00Z',
      body: 'Deal. $2,390 works. Booking it now, rate confirmation to follow from our TMS. Thank you!',
      rateCents: 239_000,
    },
  ],
  // Lost on price.
  'DQ-1011': [
    {
      id: 'm1', role: 'customer', from: 'Devon Marsh <devon@lakeshorelogistics.example.com>',
      at: '2026-08-05T13:12:00Z', subject: 'Need coverage: Indianapolis, IN to Newark, NJ, Friday',
      body: 'Looking for a dry van Indy to Newark, picking up Friday. 38,500 lbs, no-touch. What is your best number?',
    },
    {
      id: 'm2', role: 'agent', from: AGENT, at: '2026-08-05T13:19:00Z',
      body: 'Hi Devon. Indianapolis, IN to Newark, NJ, 720 miles, 53\' dry van, Friday pickup. Our all-in rate:',
      rateCents: 209_000,
    },
    {
      id: 'm3', role: 'customer', from: 'Devon Marsh <devon@lakeshorelogistics.example.com>', at: '2026-08-05T14:48:00Z',
      body: 'I have another carrier at $1,940 on this one. Can you match?',
      rateCents: 194_000,
    },
    {
      id: 'm4', role: 'sales', from: SALES, at: '2026-08-05T15:10:00Z',
      body: 'Devon, $1,940 is below our cost to run Newark empty back. The lowest I can go is $2,010, and I can guarantee the truck is on site Friday by 8 am.',
      rateCents: 201_000,
    },
    {
      id: 'm5', role: 'customer', from: 'Devon Marsh <devon@lakeshorelogistics.example.com>', at: '2026-08-05T15:36:00Z',
      body: 'Appreciate it but I need to stay at $1,940 for this customer. I will keep you in mind for the next one.',
    },
  ],
  // Lost after a counter; customer needed a lower all-in.
  'DQ-1025': [
    {
      id: 'm1', role: 'customer', from: 'Priya Natarajan <priya@redlinefreight.example.com>',
      at: '2026-09-02T16:30:00Z', subject: 'RFQ Ontario, CA to Dallas, TX, appt Friday 10:00',
      body: 'Dry van, Ontario CA to Dallas TX, 41,000 lbs. Delivery appointment Friday 10:00 so it has to load tomorrow. Please send your best rate.',
    },
    {
      id: 'm2', role: 'agent', from: AGENT, at: '2026-09-02T16:35:00Z',
      body: 'Hi Priya. Ontario, CA to Dallas, TX is 1,435 miles with a next-day load, which is a team-driver lane for a Friday 10:00 appointment. Our all-in rate:',
      rateCents: 364_000,
    },
    {
      id: 'm3', role: 'customer', from: 'Priya Natarajan <priya@redlinefreight.example.com>', at: '2026-09-02T17:20:00Z',
      body: 'I need $3,300 all-in. That is what the board is paying on this lane today.',
      rateCents: 330_000,
    },
    {
      id: 'm4', role: 'sales', from: SALES, at: '2026-09-02T17:44:00Z',
      body: 'Priya, a team on a next-day load costs more than the board average. The best I can do is $3,500 with a guaranteed on-time delivery. Let me know if that works.',
      rateCents: 350_000,
    },
    {
      id: 'm5', role: 'customer', from: 'Priya Natarajan <priya@redlinefreight.example.com>', at: '2026-09-02T18:05:00Z',
      body: 'Thanks, but I covered it at $3,390 with another carrier. Pass on this one.',
      rateCents: 339_000,
    },
  ],
  // Won after a small counter.
  'DQ-1040': [
    {
      id: 'm1', role: 'customer', from: 'Callie Burrows <callie@summitbuilding.example.com>',
      at: '2026-09-16T12:50:00Z', subject: 'Flatbed Atlanta to Jacksonville, lumber, tarps needed',
      body: 'Two bundles of dimensional lumber, 44,000 lbs, Atlanta yard to a Jacksonville job site. Needs tarps and straps. Tomorrow pickup works. Rate?',
    },
    {
      id: 'm2', role: 'agent', from: AGENT, at: '2026-09-16T12:55:00Z',
      body: 'Hi Callie. Atlanta, GA to Jacksonville, FL is 345 miles on a 48\' flatbed with tarps and straps included. Our all-in rate:',
      rateCents: 124_000,
    },
    {
      id: 'm3', role: 'customer', from: 'Callie Burrows <callie@summitbuilding.example.com>', at: '2026-09-16T13:30:00Z',
      body: 'Can you do $1,150? We have a few of these coming up.',
      rateCents: 115_000,
    },
    {
      id: 'm4', role: 'sales', from: SALES, at: '2026-09-16T13:48:00Z',
      body: 'Meet in the middle at $1,195 all-in, tarps included, pickup tomorrow morning.',
      rateCents: 119_500,
    },
    {
      id: 'm5', role: 'customer', from: 'Callie Burrows <callie@summitbuilding.example.com>', at: '2026-09-16T14:02:00Z',
      body: 'Works for me, please book it at $1,195. Driver can call the yard foreman on arrival.',
      rateCents: 119_500,
    },
  ],
}

/** The e-mail thread for a quote: hand-written when one exists, otherwise a short generated one. */
export function threadFor(quote: DemoQuote): DemoMessage[] {
  const written = WRITTEN[quote.id]
  if (written) return written

  const customer = demoCustomer(quote.customerId)
  const contact = customer ? `${customer.contact} <${customer.email}>` : 'Customer'
  const first = customer?.contact.split(' ')[0] ?? 'there'
  const lane = `${quote.origin} to ${quote.destination}`
  const start = Date.parse(`${quote.date}T14:00:00Z`)
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()

  const messages: DemoMessage[] = [
    {
      id: 'm1', role: 'customer', from: contact, at: at(0),
      subject: `Quote request: ${lane}, ${quote.equipment.toLowerCase()}`,
      body: `Hi team, can you quote ${lane}? ${quote.equipment}, ${quote.miles} miles, standard dock to dock. Let me know your rate.`,
    },
    {
      id: 'm2', role: 'agent', from: AGENT, at: at(quote.minutesToQuote),
      body: `Hi ${first}. ${lane} is ${quote.miles} miles on a ${quote.equipment.toLowerCase()}. Our all-in rate, good for 48 hours:`,
      rateCents: quote.quotedCents,
    },
  ]

  if (quote.outcome === 'won') {
    messages.push({
      id: 'm3', role: 'customer', from: contact, at: at(quote.minutesToQuote + 55),
      body: `That works, please book it at ${usd(quote.quotedCents)}. Rate confirmation to follow.`,
      rateCents: quote.quotedCents,
    })
  } else if (quote.outcome === 'lost') {
    const why = quote.competitorCents
      ? `Thanks, but I found it at ${usd(quote.competitorCents)} elsewhere, so I will go with them this time.`
      : 'Thanks, but we went another direction on this one.'
    messages.push({
      id: 'm3', role: 'customer', from: contact, at: at(quote.minutesToQuote + 95),
      body: why,
      ...(quote.competitorCents ? { rateCents: quote.competitorCents } : {}),
    })
  }
  return messages
}
