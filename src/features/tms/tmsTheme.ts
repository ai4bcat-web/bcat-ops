import { useCallback, useLayoutEffect, useState } from 'react'

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

function apply(theme: TmsTheme) {
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute(ATTRIBUTE, 'dark')
  else root.removeAttribute(ATTRIBUTE)
}

/**
 * Theme preference for the /tms/* shell. The attribute lives on <html> so portalled
 * content (dialogs, menus) follows it; it is removed on unmount so legacy pages never
 * inherit it. Only TmsShell calls this.
 */
export function useTmsTheme(): { theme: TmsTheme; setTheme: (t: TmsTheme) => void; toggleTheme: () => void } {
  const [theme, setThemeState] = useState<TmsTheme>(readTmsTheme)

  useLayoutEffect(() => {
    apply(theme)
    return () => document.documentElement.removeAttribute(ATTRIBUTE)
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
