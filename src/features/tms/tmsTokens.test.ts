// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, renderHook } from '@testing-library/react'
import { readTmsToken, useTmsTokens } from './tmsTokens'

describe('tmsTokens', () => {
  it('reads the computed value and returns empty for an unknown token', () => {
    document.body.style.setProperty('--tms-primary', ' #123456 ')
    expect(readTmsToken('--tms-primary')).toBe('#123456')
    expect(readTmsToken('--tms-nope')).toBe('')
  })

  it('re-resolves when html[data-tms-theme] flips', async () => {
    document.body.style.setProperty('--tms-primary', 'one')
    const { result } = renderHook(() => useTmsTokens(['--tms-primary'] as const))
    expect(result.current['--tms-primary']).toBe('one')
    document.body.style.setProperty('--tms-primary', 'two')
    await act(async () => {
      document.documentElement.setAttribute('data-tms-theme', 'dark')
      await Promise.resolve()
    })
    expect(result.current['--tms-primary']).toBe('two')
    document.documentElement.removeAttribute('data-tms-theme')
  })
})
