import { useCallback, useSyncExternalStore } from 'react'

/**
 * The company switcher's scope preference: which business the shell and the company
 * dashboard are focused on. `null` is "All businesses". It never changes a route,
 * a permission or a query; it only decides what is expanded and which filter the
 * dashboard opens with.
 */
export const TMS_COMPANY_KEY = 'tms-company'

/** Only used when localStorage throws (private mode): the choice then lasts for this tab. */
let memory: string | null = null
const listeners = new Set<() => void>()

export function readTmsCompany(): string | null {
  try {
    return window.localStorage.getItem(TMS_COMPANY_KEY) || null
  } catch {
    return memory
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTmsCompany(): { company: string | null; setCompany: (code: string | null) => void } {
  const company = useSyncExternalStore(subscribe, readTmsCompany, () => null)
  const setCompany = useCallback((code: string | null) => {
    memory = code
    try {
      if (code === null) window.localStorage.removeItem(TMS_COMPANY_KEY)
      else window.localStorage.setItem(TMS_COMPANY_KEY, code)
    } catch {
      /* private mode: `memory` carries the choice */
    }
    for (const listener of [...listeners]) listener()
  }, [])
  return { company, setCompany }
}
