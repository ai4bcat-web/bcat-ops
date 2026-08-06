import { describe, it, expect } from 'vitest'
import { legacyContentKey, invoiceExternalId } from './invoiceDedup.mjs'

/**
 * The keeper-selection rules, mirrored from dedupeMaintenanceInvoices.mjs. The script
 * itself signs in on import, so the pure decision logic is duplicated here deliberately
 * and pinned — picking the wrong survivor would archive a human's decision.
 */
const INVOICE_QUEUE_CUTOFF = '2026-07-30T00:00:00.000Z'
const stateOf = (inv) => {
  if (inv.status === 'ARCHIVED' || inv.status === 'POSTED' || inv.status === 'PENDING') return inv.status
  if (inv.source === 'EMAIL' && (inv.createdAt ?? '') >= INVOICE_QUEUE_CUTOFF) return 'PENDING'
  return 'POSTED'
}

function completeness(inv) {
  let score = 0
  if (inv.equipmentId && inv.equipmentId !== 'unassigned') score += 4
  if (inv.paymentMethod) score += 2
  if (inv.paymentDate) score += 2
  if (inv.description) score += 1
  if (inv.assignee) score += 1
  if (inv.reviewedBy) score += 1
  return score
}

function keepRank(inv) {
  const s = stateOf(inv)
  const decision = s === 'POSTED' ? 200 : s === 'ARCHIVED' ? 100 : 0
  return decision + completeness(inv)
}

const chooseKeeper = (group) => [...group].sort((a, b) => {
  const r = keepRank(b) - keepRank(a)
  if (r !== 0) return r
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
})[0]

const base = {
  date: '2026-07-14', vendor: 'Brothers Truck Repair', amount: 128450,
  invoiceNumber: 'INV-1042', equipmentId: 'unassigned', createdAt: '2026-07-14T10:00:00Z',
}

describe('grouping duplicates', () => {
  it('groups the original and its re-ingested copy together', () => {
    const original = { ...base, id: 'a', equipmentId: 'eq-530', status: 'POSTED' }
    const reingested = { ...base, id: 'b', equipmentId: 'unassigned', status: null }
    // Different equipmentId — the exact case the old key missed.
    expect(legacyContentKey(original)).toBe(legacyContentKey(reingested))
  })

  it('does not group genuinely different invoices', () => {
    expect(legacyContentKey({ ...base, invoiceNumber: 'INV-9' })).not.toBe(legacyContentKey(base))
  })

  it('externalId and content key agree for the same document', () => {
    const withId = { ...base, externalId: invoiceExternalId(base) }
    expect(invoiceExternalId(withId)).toBe(invoiceExternalId(base))
  })
})

describe('choosing which duplicate survives', () => {
  it('keeps the invoice a human POSTED over an untouched copy', () => {
    const posted = { ...base, id: 'posted', status: 'POSTED', createdAt: '2026-07-20T10:00:00Z' }
    // The re-ingested copy: emailed after the queue cutoff, never actioned.
    const pending = { ...base, id: 'pending', status: null, source: 'EMAIL', createdAt: '2026-08-02T10:00:00Z' }
    expect(chooseKeeper([pending, posted]).id).toBe('posted')
  })

  it('keeps an ARCHIVED decision over an untouched copy', () => {
    const archived = { ...base, id: 'archived', status: 'ARCHIVED' }
    const pending = { ...base, id: 'pending', status: 'PENDING' }
    expect(chooseKeeper([pending, archived]).id).toBe('archived')
  })

  it('prefers POSTED over ARCHIVED — an invoice on the books outranks a dismissal', () => {
    const posted = { ...base, id: 'posted', status: 'POSTED' }
    const archived = { ...base, id: 'archived', status: 'ARCHIVED' }
    expect(chooseKeeper([archived, posted]).id).toBe('posted')
  })

  it('among untouched copies, keeps the one assigned to a real truck', () => {
    const unassigned = { ...base, id: 'un', status: 'PENDING' }
    const assigned = { ...base, id: 'as', status: 'PENDING', equipmentId: 'eq-530' }
    expect(chooseKeeper([unassigned, assigned]).id).toBe('as')
  })

  it('prefers the copy carrying payment details', () => {
    const bare = { ...base, id: 'bare', status: 'PENDING' }
    const paid = { ...base, id: 'paid', status: 'PENDING', paymentMethod: 'AMEX', paymentDate: '2026-07-20' }
    expect(chooseKeeper([bare, paid]).id).toBe('paid')
  })

  it('falls back to the oldest row when everything else ties', () => {
    const older = { ...base, id: 'older', status: 'PENDING', createdAt: '2026-07-14T10:00:00Z' }
    const newer = { ...base, id: 'newer', status: 'PENDING', createdAt: '2026-08-01T10:00:00Z' }
    expect(chooseKeeper([newer, older]).id).toBe('older')
  })

  it('mirrors invoiceStatus.ts for null statuses, cutoff rule included', () => {
    expect(stateOf({ status: null })).toBe('POSTED')                       // legacy/manual
    expect(stateOf({ status: null, source: 'MANUAL' })).toBe('POSTED')
    // Emailed after the cutoff with no decision = still sitting in the queue.
    expect(stateOf({ status: null, source: 'EMAIL', createdAt: '2026-08-02T00:00:00Z' })).toBe('PENDING')
    // Emailed BEFORE the cutoff predates the queue, so it counts as posted.
    expect(stateOf({ status: null, source: 'EMAIL', createdAt: '2026-07-01T00:00:00Z' })).toBe('POSTED')
  })

  it('never picks a row outside the group it was given', () => {
    const group = [{ ...base, id: 'x', status: 'PENDING' }, { ...base, id: 'y', status: 'POSTED' }]
    expect(['x', 'y']).toContain(chooseKeeper(group).id)
  })
})
