// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { readTmsTheme, TMS_THEME_KEY, useTmsTheme } from './tmsTheme'

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-tms-theme')
})

describe('tmsTheme', () => {
  it('defaults to light and treats unknown stored values as light', () => {
    expect(readTmsTheme()).toBe('light')
    window.localStorage.setItem(TMS_THEME_KEY, 'solarized')
    expect(readTmsTheme()).toBe('light')
    const { result } = renderHook(() => useTmsTheme())
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.hasAttribute('data-tms-theme')).toBe(false)
  })

  it('persists dark and sets the attribute on <html>', () => {
    const { result } = renderHook(() => useTmsTheme())
    act(() => result.current.setTheme('dark'))
    expect(window.localStorage.getItem(TMS_THEME_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute('data-tms-theme')).toBe('dark')
  })

  it('restores a stored dark theme on mount', () => {
    window.localStorage.setItem(TMS_THEME_KEY, 'dark')
    renderHook(() => useTmsTheme())
    expect(document.documentElement.getAttribute('data-tms-theme')).toBe('dark')
  })

  it('toggling twice returns to light with the attribute removed', () => {
    const { result } = renderHook(() => useTmsTheme())
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('dark')
    act(() => result.current.toggleTheme())
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.hasAttribute('data-tms-theme')).toBe(false)
    expect(window.localStorage.getItem(TMS_THEME_KEY)).toBe('light')
  })

  it('removes the attribute on unmount so legacy pages never inherit it', () => {
    window.localStorage.setItem(TMS_THEME_KEY, 'dark')
    const { unmount } = renderHook(() => useTmsTheme())
    expect(document.documentElement.getAttribute('data-tms-theme')).toBe('dark')
    unmount()
    expect(document.documentElement.hasAttribute('data-tms-theme')).toBe(false)
  })
})
