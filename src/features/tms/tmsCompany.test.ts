// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { TMS_COMPANY_KEY, readTmsCompany, useTmsCompany } from './tmsCompany'

afterEach(() => {
  window.localStorage.clear()
})

describe('useTmsCompany', () => {
  it('defaults to All businesses (null)', () => {
    const { result } = renderHook(() => useTmsCompany())
    expect(result.current.company).toBeNull()
    expect(readTmsCompany()).toBeNull()
  })

  it('persists a choice and notifies every subscriber in the tab', () => {
    const a = renderHook(() => useTmsCompany())
    const b = renderHook(() => useTmsCompany())
    act(() => a.result.current.setCompany('ASSETS'))
    expect(window.localStorage.getItem(TMS_COMPANY_KEY)).toBe('ASSETS')
    expect(a.result.current.company).toBe('ASSETS')
    expect(b.result.current.company).toBe('ASSETS')
  })

  it('clearing removes the key and reverts to All', () => {
    const { result } = renderHook(() => useTmsCompany())
    act(() => result.current.setCompany('ASSETS'))
    act(() => result.current.setCompany(null))
    expect(window.localStorage.getItem(TMS_COMPANY_KEY)).toBeNull()
    expect(result.current.company).toBeNull()
  })
})
