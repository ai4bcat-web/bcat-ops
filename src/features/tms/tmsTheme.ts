import { useCallback, useLayoutEffect, useState } from 'react'
import { readTmsToken } from './tmsTokens'

export type TmsTheme = 'light' | 'dark'

export const TMS_THEME_KEY = 'tms-theme'

const ATTRIBUTE = 'data-tms-theme'

export function readTmsTheme(): TmsTheme {
  try {
    return window.localStorage.getItem(TMS_THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function persist(theme: TmsTheme) {
  try {
    window.localStorage.setItem(TMS_THEME_KEY, theme)
  } catch {
    // Private mode / quota: the theme still applies for this session.
  }
}

/** Browser / installed-app chrome follows the top bar, so the toggle recolours it too. */
function syncThemeColor() {
  const color = readTmsToken('--tms-topbar', document.documentElement)
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

function apply(theme: TmsTheme) {
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute(ATTRIBUTE, 'dark')
  else root.removeAttribute(ATTRIBUTE)
  syncThemeColor()
}

function clear() {
  document.documentElement.removeAttribute(ATTRIBUTE)
  syncThemeColor()
}

/**
 * Theme preference for every themed surface (the staff shell, sign-in, the driver app). The
 * attribute lives on <html> so portalled content (dialogs, menus) follows it; it is removed
 * on unmount so a surface that does not call this hook (a public page) never inherits dark.
 */
export function useTmsTheme(): { theme: TmsTheme; setTheme: (t: TmsTheme) => void; toggleTheme: () => void } {
  const [theme, setThemeState] = useState<TmsTheme>(readTmsTheme)

  useLayoutEffect(() => {
    apply(theme)
    return clear
  }, [theme])

  const setTheme = useCallback((next: TmsTheme) => {
    persist(next)
    setThemeState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: TmsTheme = current === 'dark' ? 'light' : 'dark'
      persist(next)
      return next
    })
  }, [])

  return { theme, setTheme, toggleTheme }
}
