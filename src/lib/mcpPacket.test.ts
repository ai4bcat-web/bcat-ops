import { describe, expect, it } from 'vitest'
import { RATE_CON_MCP_ERROR_PREFIX, mcpPacketStanding, rateConMcpRefusal } from './mcpPacket'

const completed = (mcpStatus: string | null | undefined) => mcpPacketStanding({ mcpStatus }).completed

describe('mcpPacketStanding', () => {
  it.each(['PENDING_REVIEW', 'ACCEPTABLE', 'MODERATE', 'UNACCEPTABLE', 'UNACCEPTABLE_REVIEW'])(
    '%s is a completed packet',
    (s) => expect(completed(s)).toBe(true),
  )

  it.each(['NOT_INVITED', 'INVITED', 'IN_PROGRESS'])('%s is not completed', (s) => expect(completed(s)).toBe(false))

  it('normalises case, padding, spaces and hyphens', () => {
    expect(completed(' acceptable ')).toBe(true)
    expect(completed('unacceptable-review')).toBe(true)
    expect(completed('In Progress')).toBe(false)
    expect(mcpPacketStanding({ mcpStatus: 'pending review' }).status).toBe('PENDING_REVIEW')
  })

  it.each([null, undefined, '', 'Ready', 'APPROVED'])('%j is not evidence of a packet', (s) => {
    expect(completed(s)).toBe(false)
  })

  it('treats a missing carrier as not completed', () => {
    expect(mcpPacketStanding(null).completed).toBe(false)
  })
})

describe('rateConMcpRefusal', () => {
  it('carries the stable prefix, the carrier and the stage', () => {
    const msg = rateConMcpRefusal('Swift', mcpPacketStanding({ mcpStatus: 'INVITED' }))
    expect(msg.startsWith(RATE_CON_MCP_ERROR_PREFIX)).toBe(true)
    expect(msg).toContain('Swift')
    expect(msg).toContain('was invited but has not started')
  })
})
