import { describe, expect, it } from 'vitest'
import { heartbeatUpdate } from './heartbeat'

const NOW = '2026-06-15T12:00:00.000Z'

describe('heartbeatUpdate', () => {
  it('writes nothing for a run that synced no carriers', () => {
    expect(heartbeatUpdate([], NOW)).toBeNull()
  })

  it('writes nothing when every carrier failed', () => {
    expect(heartbeatUpdate([{ ok: false }, { ok: false }], NOW)).toBeNull()
  })

  it('stamps the passed time and reports ok/total with no other detail', () => {
    expect(heartbeatUpdate([{ ok: true }, { ok: false }, { ok: true }], NOW)).toEqual({
      lastCheckAt: NOW,
      lastOkAt: NOW,
      healthDetail: 'Synced 2/3 carriers',
    })
  })
})
