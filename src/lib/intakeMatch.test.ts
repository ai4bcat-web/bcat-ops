import { describe, it, expect } from 'vitest'
import {
  buildLoadIndex, candidateNumbers, matchIntakeToLoad, slackBuiltReply,
} from './intakeMatch'
import type { Load } from '@/types'

function load(over: Partial<Load> = {}): Load {
  return { id: 'l1', aljexId: '14556', tmsId: '212666394', pickupNumber: '1749123', ...over } as Load
}
const index = buildLoadIndex([load()])

describe('pulling numbers out of a tender subject', () => {
  it('finds the ones the text labels', () => {
    // The three shapes that actually appear in these subjects.
    expect(candidateNumbers('Tender TMS ID 212666394: CHICAGO, IL').labelled).toEqual(['212666394'])
    expect(candidateNumbers('Fwd: Rate Confirmation for Route # 4010756658').labelled).toEqual(['4010756658'])
    expect(candidateNumbers('Fwd: Signatures Complete: Pro # 1103128').labelled).toEqual(['1103128'])
  })

  it('keeps an unlabelled number separate rather than treating it the same', () => {
    const { labelled, loose } = candidateNumbers('Fwd: FB 2284206 BFF IL - IL')
    expect(labelled).toEqual([])
    expect(loose).toEqual(['2284206'])
  })

  it('does not report a labelled number twice as a loose one', () => {
    const { labelled, loose } = candidateNumbers('TMS ID 212666394 — see 212666394')
    expect(labelled).toEqual(['212666394'])
    expect(loose).toEqual([])
  })

  it('ignores numbers too short to be an identifier', () => {
    expect(candidateNumbers('arrives 10/08 at 1400').loose).toEqual([])
  })
})

describe('matching an intake item to a load', () => {
  it('matches on the TMS id the tender names', () => {
    const m = matchIntakeToLoad('Tender TMS ID 212666394: CHICAGO, IL(10/08)', index)
    expect(m?.pro).toBe('14556')
    expect(m?.matchedOn).toBe('tmsId')
    expect(m?.confidence).toBe('LABELLED')
  })

  it('matches on the PO number', () => {
    const m = matchIntakeToLoad('PO # 1749123 ready for pickup', index)
    expect(m?.matchedOn).toBe('pickupNumber')
    expect(m?.pro).toBe('14556')
  })

  it('reports an unlabelled hit as the weaker kind', () => {
    /*
     * A bare number in a forwarded body can collide with an unrelated load by chance, and
     * a wrong match tells somebody a tender was handled when it was not. It is still worth
     * surfacing — just not as the same thing.
     */
    const m = matchIntakeToLoad('Fwd: see 212666394 attached', index)
    expect(m?.confidence).toBe('LOOSE')
  })

  it('prefers a labelled number over an unlabelled one elsewhere in the text', () => {
    const two = buildLoadIndex([
      load({ id: 'right', aljexId: '14556', tmsId: '212666394', pickupNumber: null as unknown as string }),
      load({ id: 'wrong', aljexId: '14001', tmsId: '999999999', pickupNumber: null as unknown as string }),
    ])
    const m = matchIntakeToLoad('ref 999999999 — Tender TMS ID 212666394', two)
    expect(m?.load.id).toBe('right')
    expect(m?.confidence).toBe('LABELLED')
  })

  it('returns null when nothing matches', () => {
    expect(matchIntakeToLoad('Fwd: lacrosse to norfolk, NE', index)).toBeNull()
    expect(matchIntakeToLoad('', index)).toBeNull()
  })

  it('trims a padded PRO, which the live table stores', () => {
    const padded = buildLoadIndex([load({ aljexId: '14570  ' })])
    expect(matchIntakeToLoad('TMS ID 212666394', padded)?.pro).toBe('14570')
  })

  it('falls back to the TMS id when a load carries no PRO', () => {
    const noPro = buildLoadIndex([load({ aljexId: null as unknown as string })])
    expect(matchIntakeToLoad('TMS ID 212666394', noPro)?.pro).toBe('212666394')
  })
})

describe('the reply posted back to the thread', () => {
  it('matches the wording the team already types', () => {
    // Taken verbatim from the live threads, so an automated reply reads like the others.
    expect(slackBuiltReply('14589')).toBe('PRO# 14589 - Added in BCAT Ops')
  })
})
