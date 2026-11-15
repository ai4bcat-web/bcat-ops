import { describe, expect, it } from 'vitest'
import {
  OPEN_QUESTION_PAGE, appendNote, countByStatus, filterQuestions, isOpenQuestion, parseDetails, sortQuestions, statusFor,
  toOpenQuestion, whoFromEmail,
} from './openQuestions'
import type { FeedbackItem } from '@/features/feedback/feedbackLogic'

const row = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: 'oq-1',
  page: OPEN_QUESTION_PAGE,
  summary: 'Was GIGI LINE paid?',
  details: JSON.stringify({ area: 'AP', refs: [{ pro: '14619', shipmentId: 's1', party: 'GIGI LINE INC', amount: '$1,000.00' }], aljex: 'Open $1,000.00', bcat: 'Paid' }),
  status: 'NEW',
  adminNotes: null,
  ...over,
})

describe('open questions', () => {
  it('reads a Feedback row as an open question', () => {
    const q = toOpenQuestion(row())
    expect(q.status).toBe('OPEN')
    expect(q.details.area).toBe('AP')
    expect(q.details.refs[0]).toMatchObject({ pro: '14619', shipmentId: 's1' })
    expect(q.details.aljex).toBe('Open $1,000.00')
    expect(toOpenQuestion(row({ status: 'DONE' })).status).toBe('RESOLVED')
  })

  it('tolerates bad details', () => {
    expect(parseDetails('not json')).toEqual({ area: 'OTHER', refs: [], context: 'not json' })
    expect(parseDetails(null).refs).toEqual([])
    expect(parseDetails(JSON.stringify({ area: 'XX', refs: [{ nope: 1 }, { pro: '1' }] }))).toMatchObject({ area: 'OTHER', refs: [{ pro: '1' }] })
  })

  it('only matches its own page', () => {
    expect(isOpenQuestion({ page: OPEN_QUESTION_PAGE })).toBe(true)
    expect(isOpenQuestion({ page: 'Dashboard' })).toBe(false)
  })

  it('stamps each answer and keeps the earlier ones', () => {
    const at = new Date('2026-11-15T18:00:00Z')
    const one = appendNote('', ' Not paid yet ', 'Ryne', at)
    expect(one).toBe('2026-11-15 · Ryne: Not paid yet')
    expect(appendNote(one, 'Paid 11/20', 'Jenny', at)).toBe('2026-11-15 · Ryne: Not paid yet\n2026-11-15 · Jenny: Paid 11/20')
    expect(appendNote(one, '   ', 'Ryne', at)).toBe(one)
  })

  it('names the person from the e-mail', () => {
    expect(whoFromEmail('ryne@bcatcorp.com')).toBe('Ryne')
    expect(whoFromEmail('jenny.smith@x.com')).toBe('Jenny')
    expect(whoFromEmail(null)).toBe('Someone')
  })

  it('maps resolved to the Feedback status', () => {
    expect(statusFor(true)).toBe('DONE')
    expect(statusFor(false)).toBe('NEW')
  })

  it('filters, sorts and counts', () => {
    const a = toOpenQuestion(row({ id: 'a' }))
    const b = toOpenQuestion(row({ id: 'b', status: 'DONE', summary: 'Which rate con?', details: JSON.stringify({ area: 'DOCS', refs: [{ pro: '20008' }] }) }))
    const c = toOpenQuestion(row({ id: 'c', details: JSON.stringify({ area: 'AP', refs: [{ pro: '9682', party: 'EVANS' }] }) }))
    expect(filterQuestions([a, b, c], { status: 'OPEN', area: 'ALL', query: '' }).map((q) => q.id)).toEqual(['a', 'c'])
    expect(filterQuestions([a, b, c], { status: 'ALL', area: 'DOCS', query: '' }).map((q) => q.id)).toEqual(['b'])
    expect(filterQuestions([a, b, c], { status: 'ALL', area: 'ALL', query: 'evans' }).map((q) => q.id)).toEqual(['c'])
    expect(sortQuestions([b, a, c]).map((q) => q.id)).toEqual(['c', 'a', 'b'])
    expect(countByStatus([a, b, c])).toEqual({ open: 2, resolved: 1 })
  })
})
