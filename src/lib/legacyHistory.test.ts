import { describe, expect, it } from 'vitest'
import { isLegacyHistory, wentThroughLoadReview } from './legacyHistory'

describe('isLegacyHistory', () => {
  it('is history only for an import that has not been pushed into Load Review', () => {
    expect(isLegacyHistory({ legacyImported: true })).toBe(true)
    expect(isLegacyHistory({ legacyImported: true, loadReviewPushedAt: null })).toBe(true)
    expect(isLegacyHistory({ legacyImported: true, loadReviewPushedAt: '' })).toBe(true)
  })

  it('treats a pushed import as live freight (14860)', () => {
    expect(isLegacyHistory({ legacyImported: true, loadReviewPushedAt: '2026-11-16T15:04:03.540Z' })).toBe(false)
    expect(wentThroughLoadReview({ loadReviewPushedAt: '2026-11-16T15:04:03.540Z' })).toBe(true)
  })

  it('never calls a native load history', () => {
    expect(isLegacyHistory({ legacyImported: false })).toBe(false)
    expect(isLegacyHistory({})).toBe(false)
    expect(isLegacyHistory(null)).toBe(false)
  })
})
