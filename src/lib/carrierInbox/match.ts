/**
 * Step AL §4.2 — matching an extracted inbound offer to a load. Pure: the router
 * (`tms-shipment-actions`, which owns the tables) pre-resolves facts into `MatchContext` /
 * `MatchLedger`; nothing here ever believes the model's word for a reference — only a reference
 * that resolved against `ProClaim` or a posting ledger row scores.
 *
 * Exact signals (0.85-0.95) can auto-file; the lane + date fuzzy match is capped at 0.80 and never
 * does. Medium confidence caps a match at 0.84 and low at 0.49, so neither can auto-file.
 */
import { lanePlace, matchPlace, sameEquipment } from '../laneMatch'
import type { CandidateRefs } from './refs'
import type { InboundExtraction, MatchCandidate, MatchHow, MatchSignal } from './types'

/** What the router read about one shipment the mail might belong to. */
export interface LedgerShipment {
  shipmentId: string
  shipmentNumber: string | null
  loadId: string
  laneText: string
  pickupAppt: string | null
  /** The load already has a carrier (an offer would arrive late) or is delivered. */
  covered: boolean
  voided: boolean
}

/** A `POSTED` ShipmentPosting row (the active-postings ledger). */
export interface LedgerPosting {
  postingId: string
  boardPostingId: string | null
  shipmentId: string
  loadId: string
  shipmentNumber: string | null
  originCity: string | null
  originState: string | null
  destinationCity: string | null
  destinationState: string | null
  pickupAppt: string | null
  equipmentType: string | null
  rateCents: number | null
}

export interface MatchLedger {
  /** Keyed by shipmentId. Must hold every shipment named by the context or a posting. */
  shipments: Record<string, LedgerShipment>
  postings: LedgerPosting[]
}

export interface MatchContext {
  /** `candidateRefs()` output for this message. */
  refs: CandidateRefs
  /** Normalized ref -> shipmentId, ONLY for refs that resolved (ProClaim -> Load -> shipment). */
  refToShipment: Record<string, string>
  /** shipmentIds of stored ShipmentMessages whose `messageId` equals In-Reply-To / References. */
  replyShipmentIds: string[]
}

export interface MatchConfig { autoFileMinScore: number; suggestMinScore: number }

export interface MatchResult {
  /** <= 3, score >= suggestMinScore, best first. */
  candidates: MatchCandidate[]
  decision: 'AUTO' | 'SUGGEST' | 'NONE'
  top: MatchCandidate | null
}

export const SCORE = {
  PLUS_ADDRESS: 0.95,
  REPLY_THREAD: 0.95,
  LOAD_REF_SUBJECT: 0.9,
  LOAD_REF_BODY: 0.85,
  POSTING_REF: 0.85,
  AGREEMENT_BONUS: 0.05,
  LANE_ORIGIN: 0.35,
  LANE_DESTINATION: 0.35,
  LANE_PICKUP: 0.15,
  LANE_EQUIPMENT: 0.1,
  LANE_RATE: 0.05,
  LANE_CAP: 0.8,
  MEDIUM_CAP: 0.84,
  LOW_CAP: 0.49,
  RUNNER_UP_GAP: 0.25,
} as const

const EPS = 1e-9
const DAY_MS = 86_400_000
const round2 = (n: number): number => Math.round(n * 100) / 100
const refKey = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

function dayOf(iso: string | null | undefined): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? '')
  const at = m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN
  return Number.isFinite(at) ? at / DAY_MS : null
}

interface Acc { signals: MatchSignal[]; postingId: string | null }

export function scoreMatches(
  x: InboundExtraction,
  ctx: MatchContext,
  ledger: MatchLedger,
  cfg: MatchConfig,
): MatchResult {
  const acc = new Map<string, Acc>()
  const add = (shipmentId: string | undefined, key: MatchHow, points: number, detail: string, postingId?: string): void => {
    if (!shipmentId) return
    const ship = ledger.shipments[shipmentId]
    if (!ship || ship.voided) return
    const entry = acc.get(shipmentId) ?? { signals: [], postingId: null }
    if (!entry.signals.some((s) => s.key === key)) entry.signals.push({ key, points, detail })
    if (postingId && !entry.postingId) entry.postingId = postingId
    acc.set(shipmentId, entry)
  }

  const subjectRefs = ctx.refs.subject
  const plusRefs = ctx.refs.plus
  for (const ref of plusRefs) add(ctx.refToShipment[ref], 'PLUS_ADDRESS', SCORE.PLUS_ADDRESS, `reference ${ref} in the To/Cc address`)
  for (const id of ctx.replyShipmentIds) add(id, 'REPLY_THREAD', SCORE.REPLY_THREAD, 'reply to a message on this load')
  for (const ref of subjectRefs) add(ctx.refToShipment[ref], 'LOAD_REF_SUBJECT', SCORE.LOAD_REF_SUBJECT, `reference ${ref} in the subject`)
  for (const ref of [...x.loadRefs, ...ctx.refs.body]) {
    if (subjectRefs.includes(ref) || plusRefs.includes(ref)) continue
    add(ctx.refToShipment[ref], 'LOAD_REF_BODY', SCORE.LOAD_REF_BODY, `reference ${ref} in the message`)
  }

  const tokens = [x.postingRef, ...subjectRefs, ...ctx.refs.body, ...x.loadRefs].map(refKey).filter((t) => t.length >= 3)
  if (tokens.length > 0) {
    for (const p of ledger.postings) {
      const ids = [p.boardPostingId, p.postingId].map(refKey).filter(Boolean)
      const hit = tokens.find((t) => ids.includes(t))
      if (hit) add(p.shipmentId, 'POSTING_REF', SCORE.POSTING_REF, `posting reference ${hit}`, p.postingId)
    }
  }

  const exact = acc.size > 0
  const fuzzy = new Map<string, Acc & { total: number }>()
  if (!exact) {
    const o = x.origin
    const d = x.destination
    if (o?.city && o.state && d?.city && d.state) {
      const wantO = lanePlace({ city: o.city, state: o.state })
      const wantD = lanePlace({ city: d.city, state: d.state })
      const wantDay = dayOf(x.pickupDate)
      for (const p of ledger.postings) {
        const ship = ledger.shipments[p.shipmentId]
        if (!ship || ship.voided) continue
        const sameO = matchPlace(wantO, lanePlace({ city: p.originCity, state: p.originState }), { zip3: false }) === 'CITY'
        const sameD = matchPlace(wantD, lanePlace({ city: p.destinationCity, state: p.destinationState }), { zip3: false }) === 'CITY'
        if (!sameO || !sameD) continue
        const signals: MatchSignal[] = [
          { key: 'LANE_ORIGIN', points: SCORE.LANE_ORIGIN, detail: `origin ${o.city}, ${o.state}` },
          { key: 'LANE_DESTINATION', points: SCORE.LANE_DESTINATION, detail: `destination ${d.city}, ${d.state}` },
        ]
        const postDay = dayOf(p.pickupAppt)
        if (wantDay != null && postDay != null && Math.abs(wantDay - postDay) <= 1) {
          signals.push({ key: 'LANE_PICKUP', points: SCORE.LANE_PICKUP, detail: 'pickup within a day' })
        }
        if (x.equipment && p.equipmentType && sameEquipment(x.equipment, p.equipmentType)) {
          signals.push({ key: 'LANE_EQUIPMENT', points: SCORE.LANE_EQUIPMENT, detail: `equipment ${x.equipment}` })
        }
        if (x.rateCents != null && p.rateCents && Math.abs(x.rateCents - p.rateCents) / p.rateCents <= 0.35) {
          signals.push({ key: 'LANE_RATE', points: SCORE.LANE_RATE, detail: 'rate within 35% of the posting' })
        }
        const total = Math.min(SCORE.LANE_CAP, signals.reduce((s, g) => s + g.points, 0))
        const prev = fuzzy.get(p.shipmentId)
        if (!prev || total > prev.total) fuzzy.set(p.shipmentId, { signals, postingId: p.postingId, total })
      }
    }
  }

  const cap = x.confidence === 'low' ? SCORE.LOW_CAP : x.confidence === 'medium' ? SCORE.MEDIUM_CAP : 1
  const built: MatchCandidate[] = []
  const push = (shipmentId: string, signals: MatchSignal[], postingId: string | null, raw: number, how: MatchHow): void => {
    const ship = ledger.shipments[shipmentId]
    built.push({
      shipmentId,
      shipmentNumber: ship.shipmentNumber,
      loadId: ship.loadId,
      postingId,
      score: round2(Math.min(raw, cap, 1)),
      how,
      signals,
      laneText: ship.laneText,
      pickupAppt: ship.pickupAppt,
      covered: ship.covered,
    })
  }
  for (const [shipmentId, entry] of acc) {
    const best = entry.signals.reduce((a, b) => (b.points > a.points ? b : a))
    push(shipmentId, entry.signals, entry.postingId, best.points + (entry.signals.length > 1 ? SCORE.AGREEMENT_BONUS : 0), best.key as MatchHow)
  }
  for (const [shipmentId, entry] of fuzzy) push(shipmentId, entry.signals, entry.postingId, entry.total, 'LANE_DATE')

  built.sort((a, b) => b.score - a.score || a.shipmentId.localeCompare(b.shipmentId))
  const candidates = built.filter((c) => c.score + EPS >= cfg.suggestMinScore).slice(0, 3)
  const top = candidates[0] ?? null
  if (!top) return { candidates: [], decision: 'NONE', top: null }

  const runnerUp = built[1]
  const auto =
    top.how !== 'LANE_DATE' &&
    x.confidence === 'high' &&
    top.score + EPS >= cfg.autoFileMinScore &&
    (!runnerUp || runnerUp.score <= top.score - SCORE.RUNNER_UP_GAP + EPS)
  return { candidates, decision: auto ? 'AUTO' : 'SUGGEST', top }
}
