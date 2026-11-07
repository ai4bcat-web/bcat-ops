import { describe, expect, it } from 'vitest'

import { extractPayload } from './extractPayload'

describe('extractPayload', () => {
  it('keeps the legacy { id } payload for vendor-ap-extract when no target is configured', () => {
    expect(extractPayload(undefined, 'row-1')).toEqual({ id: 'row-1' })
  })

  it('sends the run hand-off shape once the workflow agent is the target', () => {
    expect(extractPayload('workflow-agent', 'row-1')).toEqual({
      runFor: { sourceKind: 'VENDOR_PAYABLE', sourceId: 'row-1', inboxRole: 'AP', provider: 'GMAIL' },
    })
  })
})
