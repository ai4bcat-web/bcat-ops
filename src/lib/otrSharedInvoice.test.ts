import { describe, it, expect } from 'vitest'
import { checkOtrInvoiceUnshared, priorInvoicesOf } from './otrSharedInvoice'

const prior = [
  { otrInvoiceId: '26165385', otrStatus: '4', otrSubmittedAt: null, otrSubmittedBy: null, replacedAt: '2026-11-17', replacedBy: 'ryne' },
]

describe('checkOtrInvoiceUnshared', () => {
  it('lets a fresh invoice id through', () => {
    expect(checkOtrInvoiceUnshared('fi-1', '20041', '26192712', [], []).ok).toBe(true)
  })

  it('refuses an id this row already used, and names its old status', () => {
    const v = checkOtrInvoiceUnshared('fi-1', '20041', 26165385, prior, [])
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('prior')
      expect(v.message).toBe(
        'OTR gave back invoice 26165385, which 20041 already used before (4 at OTR). Nothing was attached. Ask OTR to void invoice 26165385, or change the invoice number.',
      )
    }
  })

  it('reads a prior list that arrives as JSON text', () => {
    expect(priorInvoicesOf(JSON.stringify(prior))).toHaveLength(1)
    expect(checkOtrInvoiceUnshared('fi-1', '20041', '26165385', JSON.stringify(prior), []).ok).toBe(false)
  })

  it('tolerates a prior list that is missing, null or not JSON', () => {
    expect(priorInvoicesOf(undefined)).toEqual([])
    expect(priorInvoicesOf(null)).toEqual([])
    expect(priorInvoicesOf('{not json')).toEqual([])
  })

  it('refuses an id another row holds, and names that PRO', () => {
    const v = checkOtrInvoiceUnshared('fi-1', '20041', '26165385', [], [{ id: 'fi-2', proNumber: '20000', otrInvoiceId: '26165385' }])
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('shared')
      expect(v.message).toBe(
        'OTR gave back invoice 26165385, which PRO 20000 already uses. Nothing was attached to 20041. Ask OTR to void invoice 26165385, or change the invoice number.',
      )
    }
  })

  it('does not count the row itself as another holder', () => {
    expect(checkOtrInvoiceUnshared('fi-1', '20041', '26165385', [], [{ id: 'fi-1', proNumber: '20041', otrInvoiceId: '26165385' }]).ok).toBe(true)
  })

  it('ignores holders of a different id', () => {
    expect(checkOtrInvoiceUnshared('fi-1', '20041', '26192712', [], [{ id: 'fi-2', proNumber: '20000', otrInvoiceId: '26165385' }]).ok).toBe(true)
  })

  it('falls back to the row id when there is no PRO to name', () => {
    const v = checkOtrInvoiceUnshared('fi-1', null, '5', [], [{ id: 'fi-2', otrInvoiceId: '5' }])
    expect(!v.ok && v.message).toContain('fi-2')
    expect(!v.ok && v.message).toContain('fi-1')
  })
})
