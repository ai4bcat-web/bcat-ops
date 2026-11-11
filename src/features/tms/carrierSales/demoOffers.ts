/**
 * ############################  DEMO DATA ONLY  ############################
 *
 * Everything in this file is FABRICATED demo data. The shipments, carriers, MC numbers,
 * phone numbers, email addresses, rates, call transcripts and email threads are invented
 * for a product demo of the Carrier Sales "offers per load" panel. None of it is read from,
 * or written to, any API, database or AWS resource, and none of it is ever attached to a
 * real shipment. Phone numbers use the 555-01xx fictional range; email domains are `.invalid`.
 *
 * Two channels per load: the voice negotiator (Aiden) and the email negotiator.
 * ############################################################################
 */

export type VoiceOutcome = 'BOOKED' | 'ASKED_FOR_PERSON' | 'NO_DEAL' | 'HUNG_UP'
export type EmailOutcome = 'BOOKED' | 'COUNTERED' | 'DECLINED' | 'NO_DEAL'
export type LoadOfferStatus = 'BOOKED' | 'COUNTERED' | 'DECLINED' | 'NO_DEAL'

export interface DemoTranscriptLine {
  speaker: 'AIDEN' | 'CARRIER'
  text: string
}

export interface DemoVoiceCall {
  id: string
  carrierName: string
  carrierMc: string
  fromPhone: string
  startedAt: string
  lengthSec: number
  quotedLowCents: number
  quotedHighCents: number
  /** What the carrier asked for on the call. */
  askCents: number
  /** Set only when the call ended in a deal. */
  agreedCents: number | null
  outcome: VoiceOutcome
  summary: string
  handoff: string
  transcript: DemoTranscriptLine[]
}

export interface DemoEmailMessage {
  id: string
  /** CARRIER = inbound carrier email, AI = our email negotiator. */
  from: 'CARRIER' | 'AI'
  fromAddress: string
  at: string
  subject: string
  body: string
  rateCents: number | null
}

export interface DemoEmailOffer {
  id: string
  carrierName: string
  carrierMc: string
  fromAddress: string
  receivedAt: string
  /** The carrier's opening rate. */
  offeredCents: number
  /** Our counter-offers, in order. */
  counterCents: number[]
  /** The deal rate for BOOKED, otherwise null. */
  agreedCents: number | null
  outcome: EmailOutcome
  messages: DemoEmailMessage[]
}

export interface DemoShipment {
  id: string
  number: string
  origin: string
  destination: string
  pickupAt: string
  deliveryAt: string
  equipment: string
  customerName: string
  customerRateCents: number
  targetBuyCents: number
  voiceCalls: DemoVoiceCall[]
  emailOffers: DemoEmailOffer[]
}

const NEGOTIATOR_ADDRESS = 'negotiator@cowtown-demo.invalid'
const MINUTE = 60_000

function plus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE).toISOString()
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US')}`
}

/* ── Voice builder: a short, deterministic Aiden script per outcome ── */

interface VoiceSeed {
  id: string
  carrierName: string
  carrierMc: string
  fromPhone: string
  startedAt: string
  lengthSec: number
  outcome: VoiceOutcome
  quoteLow: number
  quoteHigh: number
  ask: number
  agreed: number | null
  loadNumber: string
  lane: string
  caller: string
}

function digitsSpoken(loadNumber: string): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  return loadNumber.replace(/\D/g, '').split('').map((d) => words[Number(d)]).join(' ')
}

function voiceCall(s: VoiceSeed): DemoVoiceCall {
  const lowC = s.quoteLow * 100
  const highC = s.quoteHigh * 100
  const askC = s.ask * 100
  const agreedC = s.agreed == null ? null : s.agreed * 100
  const opening: DemoTranscriptLine[] = [
    { speaker: 'AIDEN', text: 'Cowtown Express, this is Aiden. Which load are you calling about?' },
    { speaker: 'CARRIER', text: `Thank you for calling. This is ${s.caller} with ${s.carrierName}, I saw your posting on the board.` },
    { speaker: 'AIDEN', text: 'Can I get the load number? It starts with four one.' },
    { speaker: 'CARRIER', text: `Yeah, it is ${digitsSpoken(s.loadNumber)}, ${s.lane}.` },
    { speaker: 'AIDEN', text: `Got it. That load is open and I can talk rate. What are you looking to get paid to haul it?` },
    { speaker: 'CARRIER', text: `I need ${money(askC)} on that one, fuel is killing me.` },
  ]
  let tail: DemoTranscriptLine[]
  let summary: string
  let handoff: string
  if (s.outcome === 'BOOKED') {
    tail = [
      { speaker: 'AIDEN', text: `I can start you at ${money(lowC)} and go up to ${money(highC)} on this lane. Can you do ${money(highC)}?` },
      { speaker: 'CARRIER', text: `Make it ${money(agreedC ?? highC)} and you have a truck tomorrow morning.` },
      { speaker: 'AIDEN', text: `${money(agreedC ?? highC)} works. I will send the rate confirmation to the email on your MC. Anything else I can do?` },
      { speaker: 'CARRIER', text: 'That is it. Send it over, thanks Aiden.' },
    ]
    summary = `Carrier opened at ${money(askC)}. Aiden held the range and closed at ${money(agreedC ?? highC)}. Rate con to follow.`
    handoff = 'No handoff needed. Booked on the call, rate confirmation queued for the carrier email on file.'
  } else if (s.outcome === 'ASKED_FOR_PERSON') {
    tail = [
      { speaker: 'AIDEN', text: `The most I am authorized to go to on this lane is ${money(highC)}.` },
      { speaker: 'CARRIER', text: 'That is not going to work. Can I talk to a real person about this one?' },
      { speaker: 'AIDEN', text: 'Of course. I will pass your number to a dispatcher and they will call you back shortly.' },
    ]
    summary = `Carrier wanted ${money(askC)} against Aiden's ${money(lowC)} to ${money(highC)} range and asked for a person.`
    handoff = 'Handed off to dispatch. Callback requested at the number the carrier called from.'
  } else if (s.outcome === 'NO_DEAL') {
    tail = [
      { speaker: 'AIDEN', text: `Best I can do on this one is ${money(highC)}.` },
      { speaker: 'CARRIER', text: `I cannot move a truck for that. I will pass, thanks anyway.` },
      { speaker: 'AIDEN', text: 'Understood. Thanks for calling Cowtown Express, we will keep you in mind for the next one.' },
    ]
    summary = `No agreement. Carrier held at ${money(askC)}, above Aiden's ceiling of ${money(highC)}.`
    handoff = 'No handoff. Carrier logged as a decline; load stays open.'
  } else {
    tail = [{ speaker: 'AIDEN', text: `I can start at ${money(lowC)} and go up from there depending on the equipment. Are you still with me?` }]
    summary = `Caller dropped after the opening ask of ${money(askC)}. No range discussed beyond Aiden's first number.`
    handoff = 'No handoff. Call ended before a rate conversation.'
  }
  return {
    id: s.id,
    carrierName: s.carrierName,
    carrierMc: s.carrierMc,
    fromPhone: s.fromPhone,
    startedAt: s.startedAt,
    lengthSec: s.lengthSec,
    quotedLowCents: lowC,
    quotedHighCents: highC,
    askCents: askC,
    agreedCents: agreedC,
    outcome: s.outcome,
    summary,
    handoff,
    transcript: [...opening, ...tail],
  }
}

/* ── Email builder: alternating carrier asks and AI counters ── */

interface EmailSeed {
  id: string
  carrierName: string
  carrierMc: string
  fromAddress: string
  receivedAt: string
  loadNumber: string
  lane: string
  /** Rates in order: carrier, AI, carrier, AI ... a trailing carrier rate means the carrier replied last. */
  rates: number[]
  outcome: EmailOutcome
  /** Free-text last line when the thread ends without a deal. */
  closing?: 'WALKED' | 'SILENT'
}

function emailOffer(s: EmailSeed): DemoEmailOffer {
  const subject = `Re: ${s.loadNumber} ${s.lane} - rate`
  const messages: DemoEmailMessage[] = []
  s.rates.forEach((rate, i) => {
    const fromCarrier = i % 2 === 0
    const at = plus(s.receivedAt, i * (fromCarrier ? 41 : 3))
    let body: string
    if (fromCarrier && i === 0) {
      body = `Hi, we have a truck available for ${s.loadNumber} (${s.lane}). Our rate is ${money(rate * 100)} all in. MC ${s.carrierMc}. Please confirm if it is still open.`
    } else if (fromCarrier) {
      const isLast = i === s.rates.length - 1
      body = isLast && s.outcome === 'BOOKED'
        ? `That works for us. ${money(rate * 100)} on ${s.loadNumber}, please send the rate confirmation.`
        : `Thanks for the counter. We can come down to ${money(rate * 100)} but not much further on ${s.loadNumber}.`
    } else {
      const isLast = i === s.rates.length - 1
      body = isLast && s.outcome === 'BOOKED'
        ? `Agreed at ${money(rate * 100)}. Booking ${s.loadNumber} now; the rate confirmation is on its way.`
        : `Thanks for reaching out on ${s.loadNumber}. Our budget on ${s.lane} is ${money(rate * 100)}. Can you do that?`
    }
    messages.push({
      id: `${s.id}-m${i + 1}`,
      from: fromCarrier ? 'CARRIER' : 'AI',
      fromAddress: fromCarrier ? s.fromAddress : NEGOTIATOR_ADDRESS,
      at,
      subject,
      body,
      rateCents: rate * 100,
    })
  })
  if (s.closing === 'WALKED') {
    messages.push({
      id: `${s.id}-m${messages.length + 1}`, from: 'CARRIER', fromAddress: s.fromAddress,
      at: plus(s.receivedAt, s.rates.length * 41 + 20), subject, rateCents: null,
      body: `Sorry, we cannot make that number work. We will pass on ${s.loadNumber}.`,
    })
  }
  const counters = s.rates.filter((_, i) => i % 2 === 1).map((r) => r * 100)
  return {
    id: s.id,
    carrierName: s.carrierName,
    carrierMc: s.carrierMc,
    fromAddress: s.fromAddress,
    receivedAt: s.receivedAt,
    offeredCents: s.rates[0]! * 100,
    counterCents: counters,
    agreedCents: s.outcome === 'BOOKED' ? s.rates[s.rates.length - 1]! * 100 : null,
    outcome: s.outcome,
    messages,
  }
}

/* ── The seed shipments ── */

export const DEMO_SHIPMENTS: DemoShipment[] = [
  {
    id: 'demo-4101', number: 'DEMO-4101', origin: 'Chicago, IL', destination: 'Dallas, TX',
    pickupAt: '2026-11-12T14:00:00.000Z', deliveryAt: '2026-11-14T16:00:00.000Z', equipment: 'Dry van 53\'',
    customerName: 'Demo Customer: Lakeshore Foods', customerRateCents: 310_000, targetBuyCents: 240_000,
    voiceCalls: [
      voiceCall({ id: 'v-4101-1', carrierName: 'Prairie Wind Logistics', carrierMc: '884210', fromPhone: '(312) 555-0142', startedAt: '2026-11-10T15:12:00.000Z', lengthSec: 214, outcome: 'BOOKED', quoteLow: 2200, quoteHigh: 2320, ask: 2400, agreed: 2310, loadNumber: '4101', lane: 'Chicago to Dallas', caller: 'Marcus' }),
      voiceCall({ id: 'v-4101-2', carrierName: 'Unknown caller', carrierMc: '—', fromPhone: '(708) 555-0178', startedAt: '2026-11-10T17:40:00.000Z', lengthSec: 19, outcome: 'HUNG_UP', quoteLow: 2200, quoteHigh: 2320, ask: 2650, agreed: null, loadNumber: '4101', lane: 'Chicago to Dallas', caller: 'someone' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4101-1', carrierName: 'Summit Haul LLC', carrierMc: '1029384', fromAddress: 'dispatch@summithaul.invalid', receivedAt: '2026-11-10T13:05:00.000Z', loadNumber: '4101', lane: 'Chicago to Dallas', rates: [2600, 2300, 2480], outcome: 'COUNTERED' }),
    ],
  },
  {
    id: 'demo-4102', number: 'DEMO-4102', origin: 'Atlanta, GA', destination: 'Newark, NJ',
    pickupAt: '2026-11-13T12:00:00.000Z', deliveryAt: '2026-11-15T20:00:00.000Z', equipment: 'Reefer 53\'',
    customerName: 'Demo Customer: Peachtree Produce', customerRateCents: 420_000, targetBuyCents: 330_000,
    voiceCalls: [
      voiceCall({ id: 'v-4102-1', carrierName: 'Keystone Reefer Co', carrierMc: '771902', fromPhone: '(404) 555-0113', startedAt: '2026-11-10T16:25:00.000Z', lengthSec: 142, outcome: 'ASKED_FOR_PERSON', quoteLow: 3200, quoteHigh: 3350, ask: 3750, agreed: null, loadNumber: '4102', lane: 'Atlanta to Newark', caller: 'Dee' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4102-1', carrierName: 'Blue Ridge Cold Chain', carrierMc: '655871', fromAddress: 'loads@blueridgecold.invalid', receivedAt: '2026-11-10T11:30:00.000Z', loadNumber: '4102', lane: 'Atlanta to Newark', rates: [3650, 3300, 3550, 3350, 3450, 3450], outcome: 'BOOKED' }),
      emailOffer({ id: 'e-4102-2', carrierName: 'Tidewater Express', carrierMc: '918223', fromAddress: 'ops@tidewaterexp.invalid', receivedAt: '2026-11-10T12:10:00.000Z', loadNumber: '4102', lane: 'Atlanta to Newark', rates: [3900, 3300], outcome: 'DECLINED', closing: 'WALKED' }),
    ],
  },
  {
    id: 'demo-4103', number: 'DEMO-4103', origin: 'Los Angeles, CA', destination: 'Phoenix, AZ',
    pickupAt: '2026-11-11T16:00:00.000Z', deliveryAt: '2026-11-12T10:00:00.000Z', equipment: 'Dry van 53\'',
    customerName: 'Demo Customer: Sunbelt Home Goods', customerRateCents: 145_000, targetBuyCents: 105_000,
    voiceCalls: [
      voiceCall({ id: 'v-4103-1', carrierName: 'Desert Sun Carriers', carrierMc: '540117', fromPhone: '(213) 555-0166', startedAt: '2026-11-10T14:02:00.000Z', lengthSec: 97, outcome: 'NO_DEAL', quoteLow: 1000, quoteHigh: 1080, ask: 1350, agreed: null, loadNumber: '4103', lane: 'Los Angeles to Phoenix', caller: 'Ray' }),
      voiceCall({ id: 'v-4103-2', carrierName: 'Mojave Express Inc', carrierMc: '332098', fromPhone: '(909) 555-0129', startedAt: '2026-11-10T18:15:00.000Z', lengthSec: 118, outcome: 'NO_DEAL', quoteLow: 1000, quoteHigh: 1080, ask: 1250, agreed: null, loadNumber: '4103', lane: 'Los Angeles to Phoenix', caller: 'Tomas' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4103-1', carrierName: 'Joshua Tree Trucking', carrierMc: '1187450', fromAddress: 'quotes@jttrucking.invalid', receivedAt: '2026-11-10T09:45:00.000Z', loadNumber: '4103', lane: 'Los Angeles to Phoenix', rates: [1300, 1050], outcome: 'NO_DEAL', closing: 'SILENT' }),
    ],
  },
  {
    id: 'demo-4104', number: 'DEMO-4104', origin: 'Houston, TX', destination: 'Memphis, TN',
    pickupAt: '2026-11-14T13:00:00.000Z', deliveryAt: '2026-11-15T21:00:00.000Z', equipment: 'Flatbed 48\'',
    customerName: 'Demo Customer: Gulf Steel Supply', customerRateCents: 290_000, targetBuyCents: 220_000,
    voiceCalls: [
      voiceCall({ id: 'v-4104-1', carrierName: 'Bayou Flatbed Lines', carrierMc: '702331', fromPhone: '(713) 555-0191', startedAt: '2026-11-10T19:30:00.000Z', lengthSec: 31, outcome: 'HUNG_UP', quoteLow: 2150, quoteHigh: 2250, ask: 2600, agreed: null, loadNumber: '4104', lane: 'Houston to Memphis', caller: 'Lon' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4104-1', carrierName: 'Lone Star Heavy Haul', carrierMc: '845519', fromAddress: 'dispatch@lonestarhh.invalid', receivedAt: '2026-11-10T10:20:00.000Z', loadNumber: '4104', lane: 'Houston to Memphis', rates: [2700, 2200, 2500], outcome: 'COUNTERED' }),
      emailOffer({ id: 'e-4104-2', carrierName: 'Delta Steel Haulers', carrierMc: '619047', fromAddress: 'bids@deltasteel.invalid', receivedAt: '2026-11-10T12:55:00.000Z', loadNumber: '4104', lane: 'Houston to Memphis', rates: [2550, 2200], outcome: 'COUNTERED' }),
      emailOffer({ id: 'e-4104-3', carrierName: 'Magnolia Transport', carrierMc: '990612', fromAddress: 'sales@magnoliatrans.invalid', receivedAt: '2026-11-10T14:40:00.000Z', loadNumber: '4104', lane: 'Houston to Memphis', rates: [3100, 2200], outcome: 'DECLINED', closing: 'WALKED' }),
    ],
  },
  {
    id: 'demo-4105', number: 'DEMO-4105', origin: 'Denver, CO', destination: 'Kansas City, MO',
    pickupAt: '2026-11-12T09:00:00.000Z', deliveryAt: '2026-11-13T15:00:00.000Z', equipment: 'Dry van 53\'',
    customerName: 'Demo Customer: Front Range Beverage', customerRateCents: 190_000, targetBuyCents: 140_000,
    voiceCalls: [
      voiceCall({ id: 'v-4105-1', carrierName: 'Mile High Freight', carrierMc: '478820', fromPhone: '(303) 555-0104', startedAt: '2026-11-10T13:20:00.000Z', lengthSec: 188, outcome: 'BOOKED', quoteLow: 1350, quoteHigh: 1450, ask: 1600, agreed: 1420, loadNumber: '4105', lane: 'Denver to Kansas City', caller: 'Priya' }),
      voiceCall({ id: 'v-4105-2', carrierName: 'Plains Runner LLC', carrierMc: '821745', fromPhone: '(720) 555-0150', startedAt: '2026-11-10T15:50:00.000Z', lengthSec: 126, outcome: 'ASKED_FOR_PERSON', quoteLow: 1350, quoteHigh: 1450, ask: 1700, agreed: null, loadNumber: '4105', lane: 'Denver to Kansas City', caller: 'Gil' }),
      voiceCall({ id: 'v-4105-3', carrierName: 'Arrowhead Carriers', carrierMc: '390284', fromPhone: '(816) 555-0137', startedAt: '2026-11-10T16:35:00.000Z', lengthSec: 74, outcome: 'NO_DEAL', quoteLow: 1350, quoteHigh: 1450, ask: 1650, agreed: null, loadNumber: '4105', lane: 'Denver to Kansas City', caller: 'Cass' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4105-1', carrierName: 'Rocky Mountain Dry Van', carrierMc: '556693', fromAddress: 'dispatch@rmdryvan.invalid', receivedAt: '2026-11-10T08:30:00.000Z', loadNumber: '4105', lane: 'Denver to Kansas City', rates: [1750, 1400], outcome: 'DECLINED', closing: 'WALKED' }),
      emailOffer({ id: 'e-4105-2', carrierName: 'Heartland Haulers', carrierMc: '1004278', fromAddress: 'loads@heartlandhaul.invalid', receivedAt: '2026-11-10T10:05:00.000Z', loadNumber: '4105', lane: 'Denver to Kansas City', rates: [1620, 1400], outcome: 'NO_DEAL', closing: 'SILENT' }),
    ],
  },
  {
    id: 'demo-4106', number: 'DEMO-4106', origin: 'Nashville, TN', destination: 'Charlotte, NC',
    pickupAt: '2026-11-13T10:00:00.000Z', deliveryAt: '2026-11-14T14:00:00.000Z', equipment: 'Dry van 53\'',
    customerName: 'Demo Customer: Music City Furniture', customerRateCents: 115_000, targetBuyCents: 82_000,
    voiceCalls: [
      voiceCall({ id: 'v-4106-1', carrierName: 'Smoky Mountain Freight', carrierMc: '267145', fromPhone: '(615) 555-0183', startedAt: '2026-11-10T17:05:00.000Z', lengthSec: 133, outcome: 'ASKED_FOR_PERSON', quoteLow: 800, quoteHigh: 870, ask: 980, agreed: null, loadNumber: '4106', lane: 'Nashville to Charlotte', caller: 'Bo' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4106-1', carrierName: 'Carolina Coastal Carriers', carrierMc: '733058', fromAddress: 'ops@carolinacoastal.invalid', receivedAt: '2026-11-10T09:15:00.000Z', loadNumber: '4106', lane: 'Nashville to Charlotte', rates: [950, 820, 900], outcome: 'COUNTERED' }),
      emailOffer({ id: 'e-4106-2', carrierName: 'Piedmont Logistics', carrierMc: '412967', fromAddress: 'dispatch@piedmontlog.invalid', receivedAt: '2026-11-10T11:50:00.000Z', loadNumber: '4106', lane: 'Nashville to Charlotte', rates: [880, 820], outcome: 'COUNTERED' }),
    ],
  },
  {
    id: 'demo-4107', number: 'DEMO-4107', origin: 'Seattle, WA', destination: 'Salt Lake City, UT',
    pickupAt: '2026-11-15T08:00:00.000Z', deliveryAt: '2026-11-17T12:00:00.000Z', equipment: 'Reefer 53\'',
    customerName: 'Demo Customer: Cascade Dairy Co-op', customerRateCents: 360_000, targetBuyCents: 275_000,
    voiceCalls: [
      voiceCall({ id: 'v-4107-1', carrierName: 'Evergreen Cold Freight', carrierMc: '610982', fromPhone: '(206) 555-0120', startedAt: '2026-11-10T14:45:00.000Z', lengthSec: 109, outcome: 'NO_DEAL', quoteLow: 2650, quoteHigh: 2750, ask: 3200, agreed: null, loadNumber: '4107', lane: 'Seattle to Salt Lake City', caller: 'Hanna' }),
      voiceCall({ id: 'v-4107-2', carrierName: 'Unknown caller', carrierMc: '—', fromPhone: '(425) 555-0199', startedAt: '2026-11-10T16:10:00.000Z', lengthSec: 22, outcome: 'HUNG_UP', quoteLow: 2650, quoteHigh: 2750, ask: 3100, agreed: null, loadNumber: '4107', lane: 'Seattle to Salt Lake City', caller: 'someone' }),
      voiceCall({ id: 'v-4107-3', carrierName: 'Wasatch Reefer Lines', carrierMc: '388710', fromPhone: '(801) 555-0175', startedAt: '2026-11-10T18:55:00.000Z', lengthSec: 151, outcome: 'ASKED_FOR_PERSON', quoteLow: 2650, quoteHigh: 2750, ask: 3000, agreed: null, loadNumber: '4107', lane: 'Seattle to Salt Lake City', caller: 'Dale' }),
    ],
    emailOffers: [
      emailOffer({ id: 'e-4107-1', carrierName: 'Cascade Cold Haul', carrierMc: '927304', fromAddress: 'dispatch@cascadecold.invalid', receivedAt: '2026-11-10T10:40:00.000Z', loadNumber: '4107', lane: 'Seattle to Salt Lake City', rates: [3250, 2700, 2950], outcome: 'COUNTERED' }),
      emailOffer({ id: 'e-4107-2', carrierName: 'Snake River Transport', carrierMc: '501876', fromAddress: 'quotes@snakerivertrans.invalid', receivedAt: '2026-11-10T12:20:00.000Z', loadNumber: '4107', lane: 'Seattle to Salt Lake City', rates: [3400, 2700], outcome: 'DECLINED', closing: 'WALKED' }),
      emailOffer({ id: 'e-4107-3', carrierName: 'Bonneville Reefer Co', carrierMc: '1120693', fromAddress: 'ops@bonnevillereefer.invalid', receivedAt: '2026-11-10T13:35:00.000Z', loadNumber: '4107', lane: 'Seattle to Salt Lake City', rates: [3050, 2700], outcome: 'NO_DEAL', closing: 'SILENT' }),
    ],
  },
]

/* ── Pure helpers used by the panel and the list rows ── */

export function demoShipmentFor(idOrNumber: string): DemoShipment | null {
  return DEMO_SHIPMENTS.find((s) => s.id === idOrNumber || s.number === idOrNumber) ?? null
}

export function offerCount(s: DemoShipment): { voice: number; email: number; total: number } {
  return { voice: s.voiceCalls.length, email: s.emailOffers.length, total: s.voiceCalls.length + s.emailOffers.length }
}

/** The rate a carrier is currently at: the deal rate, else the carrier's last stated rate, else their ask. */
export function emailCarrierRateCents(o: DemoEmailOffer): number {
  if (o.agreedCents != null) return o.agreedCents
  const carrierMsgs = o.messages.filter((m) => m.from === 'CARRIER' && m.rateCents != null)
  return carrierMsgs[carrierMsgs.length - 1]?.rateCents ?? o.offeredCents
}

export function voiceCarrierRateCents(c: DemoVoiceCall): number {
  return c.agreedCents ?? c.askCents
}

export interface DemoSummary {
  status: LoadOfferStatus
  lowestCents: number | null
  lowestChannel: 'VOICE' | 'EMAIL' | null
  lowestCarrier: string | null
}

export function summarize(s: DemoShipment): DemoSummary {
  const rates: Array<{ cents: number; channel: 'VOICE' | 'EMAIL'; carrier: string }> = [
    ...s.voiceCalls.filter((c) => c.carrierMc !== '—').map((c) => ({ cents: voiceCarrierRateCents(c), channel: 'VOICE' as const, carrier: c.carrierName })),
    ...s.emailOffers.map((o) => ({ cents: emailCarrierRateCents(o), channel: 'EMAIL' as const, carrier: o.carrierName })),
  ]
  const best = rates.reduce<(typeof rates)[number] | null>((acc, r) => (acc === null || r.cents < acc.cents ? r : acc), null)
  const booked = s.voiceCalls.some((c) => c.outcome === 'BOOKED') || s.emailOffers.some((o) => o.outcome === 'BOOKED')
  const open = s.voiceCalls.some((c) => c.outcome === 'ASKED_FOR_PERSON') || s.emailOffers.some((o) => o.outcome === 'COUNTERED')
  const declined = s.emailOffers.some((o) => o.outcome === 'DECLINED')
  const status: LoadOfferStatus = booked ? 'BOOKED' : open ? 'COUNTERED' : declined ? 'DECLINED' : 'NO_DEAL'
  return { status, lowestCents: best?.cents ?? null, lowestChannel: best?.channel ?? null, lowestCarrier: best?.carrier ?? null }
}
