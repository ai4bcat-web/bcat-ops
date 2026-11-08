import { describe, expect, it } from 'vitest'
import { readBuildInfo } from './buildInfo'

describe('readBuildInfo', () => {
  it('is all null, never throwing, when the define is absent', () => {
    expect(readBuildInfo(null, 'ops.example.com')).toEqual({
      commit: null, jobId: null, branch: null, builtAt: null, isDev: false,
    })
  })

  it('is dev on branch dev', () => {
    expect(readBuildInfo({ branch: 'dev' }, 'ops.example.com').isDev).toBe(true)
    expect(readBuildInfo({ branch: 'main' }, 'dev.d1.amplifyapp.com').isDev).toBe(false)
  })

  it('falls back to a dev. host only when the branch is unknown', () => {
    expect(readBuildInfo({ branch: null }, 'dev.d1.amplifyapp.com').isDev).toBe(true)
    expect(readBuildInfo({ branch: '' }, 'main.d1.amplifyapp.com').isDev).toBe(false)
  })
})
