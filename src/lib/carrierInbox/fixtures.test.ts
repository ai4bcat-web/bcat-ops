import { describe, expect, it } from 'vitest'
import { AL_FIXTURE_REFS as R, CARRIER_INBOX_CALL_FIXTURES, CARRIER_INBOX_MAIL_FIXTURES, FIXTURE_DISTRIBUTION_ADDRESS } from './fixtures'
import { scoreMatches, type MatchLedger } from './match'
import { normalizeInboundExtraction } from './normalize'
import { authOkFromHeaders, prefilterStage1, prefilterStage2, prepareInboundBody } from './prefilter'
import { allRefsToResolve, candidateRefs } from './refs'
import { DEFAULT_CARRIER_INBOX_CONFIG } from './settings'
import type { CarrierInboxMailbox, FileOutcome } from './types'

const mailbox: CarrierInboxMailbox = {
  id: 'm1', label: 'Loads', account: 'ai4bcat-sim@example.invalid', addresses: [FIXTURE_DISTRIBUTION_ADDRESS], gmailLabel: null, mode: 'SIMULATED', paused: false,
}
const cfg = { ...DEFAULT_CARRIER_INBOX_CONFIG, mailboxes: [mailbox] }

// The ZZ world a harness seeds, as the router would read it.
const proClaim: Record<string, string> = {
  [R.open]: 's-open', [R.boardPost]: 's-board', [R.lane]: 's-lane', [R.inquiry]: 's-inquiry', [R.covered]: 's-covered', [R.forwarded]: 's-fwd',
}
const lane = (id: string, over = {}) => ({
  shipmentId: id, shipmentNumber: id, loadId: `l-${id}`, laneText: 'x', pickupAppt: R.pickupDate, covered: false, voided: false, ...over,
})
const ledger: MatchLedger = {
  shipments: {
    's-open': lane('s-open'), 's-board': lane('s-board'), 's-lane': lane('s-lane'), 's-inquiry': lane('s-inquiry'),
    's-covered': lane('s-covered', { covered: true }), 's-fwd': lane('s-fwd'),
  },
  postings: [
    {
      postingId: 'post:s-board:DAT', boardPostingId: R.postingRef, shipmentId: 's-board', loadId: 'l-s-board', shipmentNumber: null,
      originCity: 'Peoria', originState: 'IL', destinationCity: 'Dayton', destinationState: 'OH', pickupAppt: R.pickupDate, equipmentType: 'VAN', rateCents: 190_000,
    },
    {
      postingId: 'post:s-lane:DAT', boardPostingId: null, shipmentId: 's-lane', loadId: 'l-s-lane', shipmentNumber: null,
      originCity: 'Joliet', originState: 'IL', destinationCity: 'Fort Wayne', destinationState: 'IN', pickupAppt: R.pickupDate, equipmentType: 'VAN', rateCents: 170_000,
    },
  ],
}

type Predicted = FileOutcome | 'STAGE1_DROP' | 'STAGE2_DROP' | 'NOT_RELEVANT'

describe('fixtures drive the pure pipeline to their documented outcomes', () => {
  const seenKeys = new Set<string>()
  for (const f of CARRIER_INBOX_MAIL_FIXTURES) {
    it(`${f.label}`, () => {
      const m = f.message
      const meta = { ...m, threadId: m.id, internalDate: String(Date.now()), replyTo: null, references: null }
      const v1 = prefilterStage1(meta, cfg, mailbox, { addresses: [], keywords: [] })
      let outcome: Predicted
      if (!v1.pass) outcome = 'STAGE1_DROP'
      else if (!prefilterStage2(prepareInboundBody(m.subject, m.body), { boardRelay: !!v1.boardProvider }).pass) outcome = 'STAGE2_DROP'
      else {
        const x = normalizeInboundExtraction(f.devExtraction ?? {}, {
          receivedAt: new Date().toISOString(), senderEmail: m.from.replace(/^.*<|>$/g, ''), authOk: authOkFromHeaders(m.headers, m.from),
          boardProvider: v1.boardProvider,
        })
        if (x.kind === 'NOT_RELEVANT') outcome = 'NOT_RELEVANT'
        else if (seenKeys.has(m.messageId)) outcome = 'DUPLICATE'
        else {
          seenKeys.add(m.messageId)
          const refs = candidateRefs(m.subject, prepareInboundBody(m.subject, m.body), m.to, m.cc)
          const refToShipment = Object.fromEntries(allRefsToResolve(x, refs).filter((r) => proClaim[r]).map((r) => [r, proClaim[r]]))
          const r = scoreMatches(x, { refs, refToShipment, replyShipmentIds: [] }, ledger, cfg)
          if (r.decision === 'AUTO') outcome = r.top?.covered ? 'COVERED_LATE' : x.kind === 'OFFER' ? 'FILED' : 'THREAD_ONLY'
          else outcome = r.decision === 'SUGGEST' ? 'SUGGESTED' : 'UNMATCHED'
          for (const flag of f.expectFlags ?? []) {
            if (flag !== 'MC_NAME_MISMATCH') expect(x.flags).toContain(flag) // MC_NAME_MISMATCH is added by the router
          }
        }
      }
      expect(outcome).toBe(f.expect)
    })
  }
  it('has the 15 mail and 2 call fixtures, unique ids, and the replay shares the call id', () => {
    expect(CARRIER_INBOX_MAIL_FIXTURES).toHaveLength(15)
    expect(new Set(CARRIER_INBOX_MAIL_FIXTURES.map((f) => f.id)).size).toBe(15)
    const [a, b] = CARRIER_INBOX_CALL_FIXTURES
    expect(a.call.callSid).toBe(b.call.callSid)
  })
})
