/**
 * OTR's statuses, named the way OTR names them. The v2 API sends a NUMBER and the portal
 * shows a WORD, so the job here is to turn one into the other without inventing wording the
 * office would then have to reconcile against the portal by eye.
 */
import { describe, it, expect } from 'vitest'
import { otrStatusMeta, otrStatusLabel, localStatusFor, OTR_STATUSES } from './otrInvoiceStatus'

describe('the labels OTR actually uses', () => {
  it('uses the portal wording, not the API documentation wording', () => {
    /*
     * OTR's docs call 6 "Current Client Request" and 8 "OTR Followup"; their portal board
     * shows "IssueClient" and "IssueFollowUp". The portal is what the office is looking at.
     */
    expect(otrStatusLabel(6)).toBe('IssueClient')
    expect(otrStatusLabel(8)).toBe('IssueFollowUp')
    expect(otrStatusLabel(1)).toBe('Pending')
  })

  it('covers every documented code', () => {
    for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 99]) {
      expect(OTR_STATUSES[code]).toBeTruthy()
      expect(OTR_STATUSES[code].label.length).toBeGreaterThan(0)
    }
  })

  it('reads a numeric status sent as a string', () => {
    // DynamoDB round-trips and older rows both hand this back as text.
    expect(otrStatusLabel('1')).toBe('Pending')
    expect(otrStatusLabel(' 8 ')).toBe('IssueFollowUp')
  })

  it('still understands a status stored as a label by the old v1 sync', () => {
    expect(otrStatusMeta('Pending')?.code).toBe(1)
    expect(otrStatusMeta('approved')?.code).toBe(3)
  })

  it('shows an unknown CODE as the code rather than a blank', () => {
    // A new OTR status is something to go and look up; an empty cell just looks broken.
    const m = otrStatusMeta(12)
    expect(m?.label).toBe('Status 12')
  })

  it('passes an unknown LABEL through as OTR sent it', () => {
    expect(otrStatusMeta('Something New')?.label).toBe('Something New')
  })

  it('is nothing at all for a missing status', () => {
    expect(otrStatusMeta(null)).toBeNull()
    expect(otrStatusMeta('')).toBeNull()
    expect(otrStatusMeta(undefined)).toBeNull()
  })
})

describe('which statuses need chasing', () => {
  it('flags the ones where OTR or the broker is waiting on us', () => {
    for (const code of [5, 6, 7, 8, 99]) {
      expect(OTR_STATUSES[code].needsAttention).toBe(true)
    }
  })

  it('does not flag an invoice that is simply working its way through', () => {
    for (const code of [1, 2, 3, 9]) {
      expect(OTR_STATUSES[code].needsAttention).toBe(false)
    }
  })
})

describe('closing a queue row out', () => {
  it('only Approved marks it factored', () => {
    expect(localStatusFor(3)).toBe('FACTORED')
  })

  it('leaves everything else pending with OTR', () => {
    for (const code of [1, 2, 5, 6, 8, 9, 99]) {
      expect(localStatusFor(code)).toBe('PENDING_WITH_OTR')
    }
  })

  it('does not file Dead or Duplicate as finished', () => {
    /*
     * Both are terminal, but neither is money. Filing them as factored would quietly
     * remove a row that somebody still has to do something about.
     */
    expect(localStatusFor(4)).toBe('PENDING_WITH_OTR')
    expect(localStatusFor(7)).toBe('PENDING_WITH_OTR')
  })

  it('does not mark an unknown status factored', () => {
    expect(localStatusFor(12)).toBe('PENDING_WITH_OTR')
    expect(localStatusFor(null)).toBe('PENDING_WITH_OTR')
  })
})

describe('a row OTR has not spoken about', () => {
  it('has no status at all, rather than "Pending"', () => {
    /*
     * "Pending" is one of OTR's own statuses (code 1). Defaulting to it meant a freshly
     * submitted row displayed a status in OTR's wording that OTR had never sent — which
     * reads as fact and is wrong the moment OTR says something else.
     */
    expect(otrStatusMeta(null)).toBeNull()
    expect(otrStatusMeta(undefined)).toBeNull()
    expect(otrStatusMeta('')).toBeNull()
  })

  it('is not treated as factored either', () => {
    expect(localStatusFor(null)).toBe('PENDING_WITH_OTR')
  })
})
