import { describe, it, expect } from 'vitest'
import { prepareFixedExpenses, applyFixedExpenseChange } from './fixedExpenseHistory'
import type { FixedExpenseInput } from './driverPay'
import { effectiveFixedExpenses } from './driverPay'

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const idSeq = () => {
  let n = 0
  return () => `id-${n++}`
}

const audit = (makeId?: () => string) => ({
  at: '2026-09-11T12:00:00.000Z',
  by: 'user-1',
  ...(makeId ? { makeId } : {}),
})

describe('prepareFixedExpenses', () => {
  it('assigns missing revisionId and expenseId while preserving other fields', () => {
    const makeId = idSeq()
    const prepared = prepareFixedExpenses(
      [
        { label: 'ELD', amount: 20, from: '2026-09-01' },
        { label: 'PLATES', amount: 75, revisionId: 'existing-rev' },
      ],
      makeId,
    )
    expect(prepared[0].revisionId).toBe('id-0')
    expect(prepared[0].expenseId).toBe('id-1')
    expect(prepared[0].label).toBe('ELD')
    expect(prepared[0].amount).toBe(20)
    expect(prepared[1].revisionId).toBe('existing-rev')
    expect(prepared[1].expenseId).toBe('id-2')
  })

  it('does not mutate the input entries', () => {
    const input: FixedExpenseInput[] = [{ label: 'X', amount: 10 }]
    prepareFixedExpenses(input, idSeq())
    expect(input[0].revisionId).toBeUndefined()
  })
})

describe('applyFixedExpenseChange — add', () => {
  it('appends an unbounded new expense with audit metadata', () => {
    const makeId = idSeq()
    const next = applyFixedExpenseChange(
      [],
      { kind: 'add', label: 'ELD', amount: 20, effectiveFrom: '2026-09-06' },
      audit(makeId),
    )
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({
      label: 'ELD',
      amount: 20,
      from: '2026-09-06',
      until: null,
      revisionId: 'id-0',
      expenseId: 'id-1',
      recordedAt: '2026-09-11T12:00:00.000Z',
      recordedBy: 'user-1',
      endedAt: null,
      endedBy: null,
    })
  })

  it('rejects an invalid effectiveFrom date', () => {
    expect(() =>
      applyFixedExpenseChange([], { kind: 'add', label: 'X', amount: 10, effectiveFrom: 'bad' }, audit()),
    ).toThrow('effectiveFrom')
  })

  it('rejects a non-blank label or malformed amount', () => {
    expect(() =>
      applyFixedExpenseChange([], { kind: 'add', label: '', amount: 10, effectiveFrom: '2026-09-06' }, audit()),
    ).toThrow('label')
    expect(() =>
      applyFixedExpenseChange([], { kind: 'add', label: 'X', amount: 0, effectiveFrom: '2026-09-06' }, audit()),
    ).toThrow('amount')
    expect(() =>
      applyFixedExpenseChange([], { kind: 'add', label: 'X', amount: 10.555, effectiveFrom: '2026-09-06' }, audit()),
    ).toThrow('decimal')
  })
})

describe('applyFixedExpenseChange — change', () => {
  const baseEntries = (): FixedExpenseInput[] =>
    prepareFixedExpenses([{ label: 'INSURANCE', amount: 100, from: '2026-09-01', until: null }], idSeq())

  it('ends the old revision and appends a replacement with the same expenseId', () => {
    const entries = baseEntries()
    const old = entries[0]
    const makeId = idSeq()
    makeId() // skip ahead to a predictable id
    makeId()
    const next = applyFixedExpenseChange(
      entries,
      { kind: 'change', revisionId: old.revisionId!, label: 'NEW INSURANCE', amount: 150, effectiveFrom: '2026-09-15' },
      audit(() => 'rev-2'),
    )
    expect(next).toHaveLength(2)
    const ended = next.find((e) => e.revisionId === old.revisionId)
    const replacement = next.find((e) => e.revisionId === 'rev-2')
    expect(ended).toMatchObject({
      until: '2026-09-15',
      endedAt: '2026-09-11T12:00:00.000Z',
      endedBy: 'user-1',
    })
    expect(replacement).toMatchObject({
      label: 'NEW INSURANCE',
      amount: 150,
      from: '2026-09-15',
      until: null,
      expenseId: old.expenseId,
      revisionId: 'rev-2',
      recordedAt: '2026-09-11T12:00:00.000Z',
      recordedBy: 'user-1',
    })
  })

  it('preserves future scheduled versions', () => {
    const entries = prepareFixedExpenses(
      [
        { label: 'INSURANCE', amount: 100, from: '2026-09-01', until: '2026-09-20', expenseId: 'e1' },
        { label: 'INSURANCE', amount: 200, from: '2026-09-20', until: null, expenseId: 'e1' },
      ],
      idSeq(),
    )
    const old = entries[0]
    const next = applyFixedExpenseChange(
      entries,
      { kind: 'change', revisionId: old.revisionId!, label: 'INSURANCE', amount: 125, effectiveFrom: '2026-09-10' },
      audit(() => 'rev-3'),
    )
    expect(next).toHaveLength(3)
    const future = next.find((e) => e.from === '2026-09-20')
    expect(future?.amount).toBe(200)
    expect(future?.expenseId).toBe(old.expenseId)
  })

  it('allows effectiveFrom equal to from, retaining a zero-length historical revision', () => {
    const entries = baseEntries()
    const old = entries[0]
    const next = applyFixedExpenseChange(
      entries,
      { kind: 'change', revisionId: old.revisionId!, label: 'NEW', amount: 50, effectiveFrom: '2026-09-01' },
      audit(() => 'rev-2'),
    )
    expect(next).toHaveLength(2)
    const ended = next.find((e) => e.revisionId === old.revisionId)
    expect(ended).toMatchObject({ from: '2026-09-01', until: '2026-09-01', endedAt: '2026-09-11T12:00:00.000Z' })
  })

  it('rejects a no-op change', () => {
    const entries = baseEntries()
    expect(() =>
      applyFixedExpenseChange(
        entries,
        { kind: 'change', revisionId: entries[0].revisionId!, label: 'INSURANCE', amount: 100, effectiveFrom: '2026-09-15' },
        audit(),
      ),
    ).toThrow('no-op')
  })

  it('rejects effectiveFrom outside the selected revision window', () => {
    const entries = prepareFixedExpenses(
      [{ label: 'X', amount: 10, from: '2026-09-01', until: '2026-09-10' }],
      idSeq(),
    )
    expect(() =>
      applyFixedExpenseChange(
        entries,
        { kind: 'change', revisionId: entries[0].revisionId!, label: 'Y', amount: 20, effectiveFrom: '2026-08-31' },
        audit(),
      ),
    ).toThrow('before')
    expect(() =>
      applyFixedExpenseChange(
        entries,
        { kind: 'change', revisionId: entries[0].revisionId!, label: 'Y', amount: 20, effectiveFrom: '2026-09-10' },
        audit(),
      ),
    ).toThrow('before revision end')
  })

  it('is immutable', () => {
    const entries = baseEntries()
    applyFixedExpenseChange(
      entries,
      { kind: 'change', revisionId: entries[0].revisionId!, label: 'Y', amount: 20, effectiveFrom: '2026-09-15' },
      audit(),
    )
    expect(entries[0].until).toBeNull()
    expect(entries[0].endedAt).toBeUndefined()
  })
})

describe('applyFixedExpenseChange — end', () => {
  it('closes a revision and keeps the ended row in history', () => {
    const entries = prepareFixedExpenses(
      [{ label: 'ESCROW', amount: 50, from: '2026-09-01', until: null }],
      idSeq(),
    )
    const next = applyFixedExpenseChange(
      entries,
      { kind: 'end', revisionId: entries[0].revisionId!, effectiveFrom: '2026-09-15' },
      audit(),
    )
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({
      until: '2026-09-15',
      endedAt: '2026-09-11T12:00:00.000Z',
      endedBy: 'user-1',
    })
  })

  it('rejects ending an already-ended revision', () => {
    const entries = prepareFixedExpenses(
      [{ label: 'ESCROW', amount: 50, from: '2026-09-01', until: '2026-09-15', endedAt: '2026-09-10T00:00:00Z' }],
      idSeq(),
    )
    expect(() =>
      applyFixedExpenseChange(
        entries,
        { kind: 'end', revisionId: entries[0].revisionId!, effectiveFrom: '2026-09-10' },
        audit(),
      ),
    ).toThrow('already ended')
  })
})

describe('window validation', () => {
  it('rejects overlapping revisions after a change', () => {
    const entries: FixedExpenseInput[] = [
      { label: 'A', amount: 10, from: '2026-09-01', until: '2026-09-30', revisionId: 'r1', expenseId: 'e1' },
      { label: 'A', amount: 20, from: '2026-09-15', until: null, revisionId: 'r2', expenseId: 'e1' },
    ]
    expect(() =>
      applyFixedExpenseChange(
        entries,
        { kind: 'end', revisionId: 'r1', effectiveFrom: '2026-09-20' },
        audit(),
      ),
    ).toThrow('overlapping')
  })
})

describe('integration with effectiveFixedExpenses', () => {
  it('a newly added expense is not charged before its from date', () => {
    const entries = applyFixedExpenseChange(
      [],
      { kind: 'add', label: 'NEW ESCROW', amount: 100, effectiveFrom: '2026-09-13' },
      audit(idSeq()),
    )
    expect(effectiveFixedExpenses(entries, '2026-09-06', addDays('2026-09-06', 6))).toEqual([])
  })

  it('a midweek change produces the expected prorated rows', () => {
    const makeId = idSeq()
    let entries = applyFixedExpenseChange(
      [],
      { kind: 'add', label: 'INSURANCE', amount: 100, effectiveFrom: '2026-09-01' },
      audit(makeId),
    )
    entries = applyFixedExpenseChange(
      entries,
      { kind: 'change', revisionId: entries[0].revisionId!, label: 'INSURANCE', amount: 200, effectiveFrom: '2026-09-09' },
      audit(() => 'rev-2'),
    )
    const r = effectiveFixedExpenses(entries, '2026-09-06', addDays('2026-09-06', 6))
    expect(r.map((f) => f.amount)).toEqual([42.86, 114.28])
  })
})
