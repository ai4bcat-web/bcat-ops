/**
 * Open/closed state of the Inbox info panel, persisted in localStorage['tms-inbox-info'].
 * Default: open on screens >= 1280px, closed below.
 */
import { useCallback, useState } from 'react'

export const INBOX_INFO_STORAGE_KEY = 'tms-inbox-info'
const WIDE_SCREEN_PX = 1280

function readOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(INBOX_INFO_STORAGE_KEY)
    if (stored === 'open') return true
    if (stored === 'closed') return false
  } catch { /* storage unavailable: fall through to the width default */ }
  return window.innerWidth >= WIDE_SCREEN_PX
}

export function useInboxInfoOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(readOpen)
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    try { window.localStorage.setItem(INBOX_INFO_STORAGE_KEY, next ? 'open' : 'closed') } catch { /* not persisted */ }
  }, [])
  return [open, setOpen]
}
