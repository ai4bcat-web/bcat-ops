/**
 * Step P11 — the Demo page's own vocabulary.
 *
 * Eleven steps, in the order Ryne runs them, each with the one line that says what
 * he will see and the screen it opens on. The checklist is read from the records —
 * a step ticks because the seeded shipment actually reached that state, never
 * because a script said so.
 */

export type DemoStepKey =
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11'

export interface DemoStepDef {
  key: DemoStepKey
  title: string
  /** One line: what you will see when you press the button. */
  whatYouSee: string
  /** The demo record this step opens on, by its seed key. */
  opensOn: string | null
  /** The tab or sub-view the record opens to, when it matters. */
  tab?: string
}

export const DEMO_STEPS: DemoStepDef[] = [
  {
    key: 'P1',
    title: 'Seeded data',
    whatYouSee: 'Forty shipments across every status and all three divisions, with the quotes, tenders, postings, offers, check calls, PODs and AR buckets behind them.',
    opensOn: null,
  },
  {
    key: 'P2',
    title: 'Assign a carrier rep or team',
    whatYouSee: 'An open shipment assigned to a carrier rep, showing in My queue and in the team queue, mirrored onto the load.',
    opensOn: 'shipment.open.assigned',
  },
  {
    key: 'P3',
    title: 'Customer flow defaults',
    whatYouSee: 'The customer whose defaults drive everything below: carrier team, 22% target margin, auto quote replies, its own required fields and a 4-hour check-call plan.',
    opensOn: 'customer.auto',
  },
  {
    key: 'P4',
    title: 'Quote in, rate out',
    whatYouSee: 'A quote request that arrived by e-mail, the DAT RateView number it was priced from (labelled stub until credentials exist), and the reply — sent automatically or waiting on Send suggested.',
    opensOn: 'quote.inbound',
  },
  {
    key: 'P5',
    title: 'Tender to a built load',
    whatYouSee: 'A shipment the tender agent built from the e-mail, still Building, with the Needs: list of the fields the customer requires and the automation could not fill.',
    opensOn: 'shipment.building',
  },
  {
    key: 'P6',
    title: 'Post to DAT and Truckstop',
    whatYouSee: 'The same shipment posted to both boards, with board ids and timestamps, and the Posted indicator on the row.',
    opensOn: 'shipment.posted',
  },
  {
    key: 'P7',
    title: 'Carrier answers the posting',
    whatYouSee: 'Three carrier offers parsed out of e-mail replies, with MC, rate and vetting status — one vetted and ready to assign, one with lapsed insurance, one unknown that needs a setup packet.',
    opensOn: 'shipment.posted',
    tab: 'carrier',
  },
  {
    key: 'P8',
    title: 'Rate con, thread and tracking',
    whatYouSee: 'The assigned carrier\'s rate confirmation, the shipment\'s own e-mail thread, the check-call texts with their tracking links, a geocoded free-text reply and an escalation after 30 minutes of silence.',
    opensOn: 'shipment.intransit',
    tab: 'tracking',
  },
  {
    key: 'P9',
    title: 'POD requested and reviewed',
    whatYouSee: 'A delivered shipment where the app asked for the POD, refused the first one on a page-count mismatch, refused the second as illegible, and flagged a human.',
    opensOn: 'shipment.podflagged',
    tab: 'documents',
  },
  {
    key: 'P10',
    title: 'Release to billing',
    whatYouSee: 'The accounting list of ready-for-billing shipments, and Release to billing going through the Step F gate rather than around it.',
    opensOn: 'shipment.readytobill',
    tab: 'documents',
  },
  {
    key: 'P11',
    title: 'Run it again',
    whatYouSee: 'Reset demo data puts every seeded record back the way it started, so the whole flow runs again from the top.',
    opensOn: null,
  },
]

/** What the Demo page's checklist reads to decide whether a step has actually happened. */
export interface DemoChecklistFacts {
  shipmentCount: number
  staffCount: number
  assignedCount: number
  customersWithFlowDefaults: number
  quotesWithMarketRate: number
  buildingShipments: number
  activePostings: number
  carrierOffers: number
  shipmentsWithThread: number
  checkCallMessages: number
  podReviews: number
  readyForBilling: number
  releasedToBilling: number
  seedVersion: string | null
}

export interface DemoChecklistRow {
  key: DemoStepKey
  done: boolean
  /** The count behind the tick, in the words the page prints. */
  evidence: string
}

/**
 * Tick a step only when the records say so.
 *
 * Each line names the number it counted, because "done" with no number is the kind
 * of green tick that hides a broken step.
 */
export function demoChecklist(facts: DemoChecklistFacts): DemoChecklistRow[] {
  return [
    { key: 'P1', done: facts.shipmentCount >= 40 && facts.staffCount >= 6, evidence: `${facts.shipmentCount} seeded shipments · ${facts.staffCount} demo staff` },
    { key: 'P2', done: facts.assignedCount > 0, evidence: `${facts.assignedCount} shipments assigned to a rep or team` },
    { key: 'P3', done: facts.customersWithFlowDefaults > 0, evidence: `${facts.customersWithFlowDefaults} customers with flow defaults` },
    { key: 'P4', done: facts.quotesWithMarketRate > 0, evidence: `${facts.quotesWithMarketRate} quotes priced from a market rate` },
    { key: 'P5', done: facts.buildingShipments > 0, evidence: `${facts.buildingShipments} shipments still Building` },
    { key: 'P6', done: facts.activePostings > 0, evidence: `${facts.activePostings} live board postings` },
    { key: 'P7', done: facts.carrierOffers > 0, evidence: `${facts.carrierOffers} carrier offers` },
    { key: 'P8', done: facts.shipmentsWithThread > 0 && facts.checkCallMessages > 0, evidence: `${facts.shipmentsWithThread} threads · ${facts.checkCallMessages} check-call messages` },
    { key: 'P9', done: facts.podReviews > 0, evidence: `${facts.podReviews} reviewed PODs` },
    { key: 'P10', done: facts.readyForBilling + facts.releasedToBilling > 0, evidence: `${facts.readyForBilling} ready for billing · ${facts.releasedToBilling} released` },
    { key: 'P11', done: Boolean(facts.seedVersion), evidence: facts.seedVersion ? `Seed ${facts.seedVersion}` : 'Not seeded' },
  ]
}
