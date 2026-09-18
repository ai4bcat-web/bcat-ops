import { describe, it, expect } from 'vitest'
import {
  stateOf,
  completeness,
  keepRank,
  chooseKeeper,
  groupInvoicesByIdentity,
  partitionArchiveCandidates,
} from './dedupeMaintenanceInvoices.mjs'

const base = {
  date: '2026-07-14',
  vendor: 'Brothers Truck Repair',
  amount: 128450,
  invoiceNumber: 'INV-1042',
  equipmentId: 'unassigned',
  createdAt: '2026-07-14T10:00:00Z',
}

describe('grouping duplicates', () => {
  it('groups a legacy row and a re-ingested row that share normalized content', () => {
    const legacy = { ...base, id: 'legacy-id', externalId: null, status: 'POSTED' }
    const reingested = { ...base, id: 'reingested-id', externalId: 'ext-abc', status: null }
    const groups = groupInvoicesByIdentity([legacy, reingested])
    expect(groups.size).toBe(1)
    expect([...groups.values()][0]).toContainEqual(legacy)
    expect([...groups.values()][0]).toContainEqual(reingested)
  })

  it('links reviewed edits by externalId even when equipmentId changed', () => {
    const externalId = 'ext-shared'
    const original = {
      ...base,
      id: 'original-id',
      externalId,
      equipmentId: 'unassigned',
      status: null,
      source: 'EMAIL',
      createdAt: '2026-07-14T10:00:00Z',
    }
    const reviewed = {
      ...base,
      id: 'reviewed-id',
      externalId,
      equipmentId: 'truck-1',
      status: 'POSTED',
      source: 'EMAIL',
      createdAt: '2026-07-15T10:00:00Z',
    }
    const groups = groupInvoicesByIdentity([original, reviewed])
    expect(groups.size).toBe(1)
    expect([...groups.values()][0].map((i) => i.id).sort()).toEqual(['original-id', 'reviewed-id'])
  })

  it('keeps truly distinct invoices separate', () => {
    const a = { ...base, id: 'a', invoiceNumber: 'INV-1042', externalId: null }
    const b = { ...base, id: 'b', invoiceNumber: 'INV-2042', externalId: null }
    const groups = groupInvoicesByIdentity([a, b])
    expect(groups.size).toBe(2)
  })

  it('merges transitive chains through externalId and content key', () => {
    // A and B share an externalId; B and C share content; A and C only connect through B.
    const a = { ...base, id: 'a', externalId: 'ext-1', invoiceNumber: 'INV-1', amount: 100 }
    const b = {
      ...base,
      id: 'b',
      externalId: 'ext-1',
      invoiceNumber: 'INV-2',
      amount: 100,
      createdAt: '2026-07-15T10:00:00Z',
    }
    const c = { ...base, id: 'c', externalId: null, invoiceNumber: 'INV-2', amount: 100 }
    const groups = groupInvoicesByIdentity([a, b, c])
    expect(groups.size).toBe(1)
    expect([...groups.values()][0].map((i) => i.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('retains unnumbered manual repeat expenses as separate rows', () => {
    // Two legitimate manual cash entries: same vendor/date/amount but no invoice number.
    const man1 = {
      ...base,
      id: 'man-1',
      source: 'MANUAL',
      invoiceNumber: '',
      externalId: null,
      equipmentId: 'truck-a',
    }
    const man2 = {
      ...base,
      id: 'man-2',
      source: 'MANUAL',
      invoiceNumber: null,
      externalId: null,
      equipmentId: 'truck-b',
    }
    const groups = groupInvoicesByIdentity([man1, man2])
    expect(groups.size).toBe(2)
  })

  it('still groups numbered EMAIL rows with legacy EMAIL rows by content', () => {
    const legacy = {
      ...base,
      id: 'legacy',
      source: 'EMAIL',
      invoiceNumber: 'INV-1042',
      externalId: null,
      status: 'POSTED',
      equipmentId: 'truck-1',
    }
    const reingested = {
      ...base,
      id: 'reingested',
      source: 'EMAIL',
      invoiceNumber: 'INV-1042',
      externalId: 'ext-email',
      status: null,
      equipmentId: 'unassigned',
    }
    const groups = groupInvoicesByIdentity([legacy, reingested])
    expect(groups.size).toBe(1)
  })
})

describe('unnumbered content grouping safety', () => {
  it('does not group unnumbered EMAIL rows by content alone when trucks differ', () => {
    const a = {
      ...base,
      id: 'a',
      source: 'EMAIL',
      invoiceNumber: '',
      externalId: null,
      equipmentId: 'truck-a',
    }
    const b = {
      ...base,
      id: 'b',
      source: 'EMAIL',
      invoiceNumber: '',
      externalId: null,
      equipmentId: 'truck-b',
    }
    const groups = groupInvoicesByIdentity([a, b])
    expect(groups.size).toBe(2)
  })

  it('groups unnumbered rows by shared externalId', () => {
    const a = { ...base, id: 'a', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'truck-a' }
    const b = { ...base, id: 'b', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'truck-b' }
    const groups = groupInvoicesByIdentity([a, b])
    expect(groups.size).toBe(1)
  })
})

describe('partitionArchiveCandidates safety review', () => {
  it('flags unnumbered duplicate groups with conflicting assigned equipment for review', () => {
    const a = { ...base, id: 'a', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'truck-a' }
    const b = { ...base, id: 'b', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'truck-b' }
    const groups = groupInvoicesByIdentity([a, b])
    const { safeToArchive, reviewNeeded } = partitionArchiveCandidates(groups)
    expect(reviewNeeded.length).toBe(1)
    expect(reviewNeeded[0].assignedEquipmentIds.sort()).toEqual(['truck-a', 'truck-b'])
    expect(safeToArchive.length).toBe(0)
  })

  it('allows auto-archive when unnumbered duplicates share the same equipment', () => {
    const a = { ...base, id: 'a', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'truck-1', status: null }
    const b = {
      ...base,
      id: 'b',
      invoiceNumber: '',
      externalId: 'ext-shared',
      equipmentId: 'truck-1',
      status: 'POSTED',
      createdAt: '2026-07-13T10:00:00Z',
    }
    const groups = groupInvoicesByIdentity([a, b])
    const { safeToArchive, reviewNeeded } = partitionArchiveCandidates(groups)
    expect(reviewNeeded.length).toBe(0)
    expect(safeToArchive.length).toBe(1)
    expect(safeToArchive[0].inv.id).toBe('a')
  })

  it('allows auto-archive when unnumbered duplicates are both unassigned', () => {
    const a = { ...base, id: 'a', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'unassigned', status: null }
    const b = { ...base, id: 'b', invoiceNumber: '', externalId: 'ext-shared', equipmentId: 'unassigned', status: 'POSTED' }
    const groups = groupInvoicesByIdentity([a, b])
    const { safeToArchive, reviewNeeded } = partitionArchiveCandidates(groups)
    expect(reviewNeeded.length).toBe(0)
    expect(safeToArchive.length).toBe(1)
  })

  it('flags numbered manual splits across different trucks for review', () => {
    const a = {
      ...base,
      id: 'a',
      source: 'MANUAL',
      invoiceNumber: '0726',
      externalId: null,
      equipmentId: 'eq-mnewwmcsjary',
      description: 'Greased legs',
      status: null,
      createdAt: '2026-07-26T10:00:00Z',
    }
    const b = {
      ...base,
      id: 'b',
      source: 'MANUAL',
      invoiceNumber: '0726',
      externalId: null,
      equipmentId: 'eq-other-unit',
      description: 'Greased legs',
      status: null,
      createdAt: '2026-07-26T10:00:00Z',
    }
    const groups = groupInvoicesByIdentity([a, b])
    const { safeToArchive, reviewNeeded } = partitionArchiveCandidates(groups)
    expect(reviewNeeded.length).toBe(1)
    expect(reviewNeeded[0].assignedEquipmentIds.sort()).toEqual(['eq-mnewwmcsjary', 'eq-other-unit'])
    expect(safeToArchive.length).toBe(0)
  })

  it('still archives numbered duplicate groups when equipment is unambiguous', () => {
    const a = { ...base, id: 'a', invoiceNumber: 'INV-1', externalId: null, equipmentId: 'truck-a', status: 'POSTED' }
    const b = { ...base, id: 'b', invoiceNumber: 'INV-1', externalId: null, equipmentId: 'unassigned', status: null }
    const groups = groupInvoicesByIdentity([a, b])
    const { safeToArchive, reviewNeeded } = partitionArchiveCandidates(groups)
    expect(reviewNeeded.length).toBe(0)
    expect(safeToArchive.length).toBe(1)
    expect(safeToArchive[0].inv.id).toBe('b')
  })
})

describe('choosing which duplicate survives', () => {
  it('keeps the invoice a human POSTED over an untouched copy', () => {
    const posted = { ...base, id: 'posted', status: 'POSTED', createdAt: '2026-07-20T10:00:00Z' }
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
    const paid = {
      ...base,
      id: 'paid',
      status: 'PENDING',
      paymentMethod: 'AMEX',
      paymentDate: '2026-07-20',
    }
    expect(chooseKeeper([bare, paid]).id).toBe('paid')
  })

  it('falls back to the oldest row when everything else ties', () => {
    const older = { ...base, id: 'older', status: 'PENDING', createdAt: '2026-07-14T10:00:00Z' }
    const newer = { ...base, id: 'newer', status: 'PENDING', createdAt: '2026-08-01T10:00:00Z' }
    expect(chooseKeeper([newer, older]).id).toBe('older')
  })
})

describe('stateOf mirrors invoice status semantics', () => {
  it('treats null status as POSTED for legacy/manual rows', () => {
    expect(stateOf({ status: null })).toBe('POSTED')
    expect(stateOf({ status: null, source: 'MANUAL' })).toBe('POSTED')
  })

  it('treats emailed-after-cutoff rows as PENDING', () => {
    expect(stateOf({ status: null, source: 'EMAIL', createdAt: '2026-08-02T00:00:00Z' })).toBe('PENDING')
  })

  it('treats emailed-before-cutoff rows as POSTED', () => {
    expect(stateOf({ status: null, source: 'EMAIL', createdAt: '2026-07-01T00:00:00Z' })).toBe('POSTED')
  })

  it('respects explicit statuses', () => {
    expect(stateOf({ status: 'PENDING' })).toBe('PENDING')
    expect(stateOf({ status: 'POSTED' })).toBe('POSTED')
    expect(stateOf({ status: 'ARCHIVED' })).toBe('ARCHIVED')
  })
})

describe('completeness scoring', () => {
  it('rewards assigned equipment, payment info, and review metadata', () => {
    const minimal = {
      ...base,
      equipmentId: 'unassigned',
      paymentMethod: null,
      paymentDate: null,
      description: null,
      assignee: null,
      reviewedBy: null,
    }
    const maximal = {
      ...base,
      equipmentId: 'truck-1',
      paymentMethod: 'CHECK',
      paymentDate: '2026-07-20',
      description: 'Oil change',
      assignee: 'user@example.com',
      reviewedBy: 'reviewer@example.com',
    }
    expect(keepRank(maximal)).toBeGreaterThan(keepRank(minimal))
    expect(completeness(maximal)).toBe(completeness(minimal) + 4 + 2 + 2 + 1 + 1 + 1)
  })
})
