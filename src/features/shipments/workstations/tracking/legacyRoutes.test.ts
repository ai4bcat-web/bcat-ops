import { describe, expect, it } from 'vitest'
import { CHECK_CALLS_LANDING, DOCS_LANDING, legacyTrackingTarget } from './legacyRoutes'

describe('legacyTrackingTarget', () => {
  it.each([
    ['/tms/check-calls', CHECK_CALLS_LANDING],
    ['/check-calls', CHECK_CALLS_LANDING],
    ['/tms/check-calls/', CHECK_CALLS_LANDING],
    ['/tms/documents/review', DOCS_LANDING],
    ['/tms/documents/view/zz-x', DOCS_LANDING],
    ['/documents', DOCS_LANDING],
  ])('%s lands on the grid', (from, to) => {
    expect(legacyTrackingTarget(from)).toBe(to)
  })

  it('leaves live and unrelated paths alone', () => {
    for (const path of ['/tms/tracking', '/tms/tracking/links', '/tms/shipments/s1', '/tms/documentsx', '/']) {
      expect(legacyTrackingTarget(path), path).toBeNull()
    }
  })

  it('names the focus the old worklist became', () => {
    expect(CHECK_CALLS_LANDING).toContain('focus=checkcalls')
    expect(DOCS_LANDING).toContain('focus=docs')
    expect(CHECK_CALLS_LANDING).toContain('assignee=all')
  })
})
