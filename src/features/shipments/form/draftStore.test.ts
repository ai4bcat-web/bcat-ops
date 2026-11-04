// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteDraft, listDrafts, loadDraft, newDraftId, saveDraft, MAX_DRAFTS, DRAFT_TTL_MS } from './draftStore'
import { emptyValues } from './model'

const email = 'zz@example.invalid'
const T = Date.now()

describe('local draft store', () => {
  beforeEach(() => { localStorage.clear() })

  it('saves, lists newest first, loads and deletes', () => {
    const a = emptyValues(); a.ship.description = 'A'
    const b = emptyValues(); b.ship.description = 'B'
    saveDraft(email, 'a', a, T)
    saveDraft(email, 'b', b, T + 1_000)
    expect(listDrafts(email, T + 3_000).map((d) => d.clientDraftId)).toEqual(['b', 'a'])
    expect(loadDraft(email, 'a')?.values.ship.description).toBe('A')
    deleteDraft(email, 'a')
    expect(loadDraft(email, 'a')).toBeNull()
  })
  it('a sixth draft evicts the oldest', () => {
    for (let i = 0; i < MAX_DRAFTS + 1; i++) saveDraft(email, `d${i}`, emptyValues(), T + i)
    const ids = listDrafts(email, T + 5_000).map((d) => d.clientDraftId)
    expect(ids).toHaveLength(MAX_DRAFTS)
    expect(ids).not.toContain('d0')
  })
  it('drafts are per user, and queued files are never serialised', () => {
    const v = emptyValues()
    v.docs.queued = [{ file: new File(['x'], 'a.txt'), audience: 'ALL', type: 'OTHER' }]
    saveDraft(email, 'x', v)
    expect(JSON.stringify(Object.values(localStorage))).not.toContain('a.txt')
    expect(loadDraft(email, 'x')?.values.docs.queued).toEqual([])
    expect(listDrafts('other@example.invalid')).toEqual([])
  })
  it('a version bump or an old draft is dropped silently', () => {
    saveDraft(email, 'old', emptyValues(), T)
    expect(listDrafts(email, T + DRAFT_TTL_MS + 1)).toEqual([])
    localStorage.setItem(`tms:ship-form:draft:${email}:v0`, JSON.stringify({ v: 0, savedAt: new Date().toISOString(), clientDraftId: 'v0', values: {} }))
    expect(loadDraft(email, 'v0')).toBeNull()
    expect(newDraftId()).toMatch(/\S/)
  })
})
