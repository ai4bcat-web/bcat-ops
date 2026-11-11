/**
 * Whether the Quote tab shows its demo data. Nothing here touches an API: the demo rows live in
 * demoQuotes.ts and are drawn client-side. Default: ON only while there are no real rows (so an empty
 * tab never looks broken), OFF as soon as real rows exist; a person's own choice is remembered per user.
 */
import { useCallback, useState } from 'react'
import { useAuth } from '@/hooks/useAuth'

export const quoteDemoKey = (email: string | null | undefined): string => `tms:quote-demo:${email ?? 'anon'}:v1`

export function readDemoChoice(key: string): boolean | null {
  try {
    const v = window.localStorage.getItem(key)
    return v === 'on' ? true : v === 'off' ? false : null
  } catch {
    return null
  }
}

export function writeDemoChoice(key: string, on: boolean): void {
  try { window.localStorage.setItem(key, on ? 'on' : 'off') } catch { /* private mode: the choice lasts for this visit */ }
}

/** Pure: the choice wins; with none, demo shows only when the real count is known to be zero (null = still loading). */
export function demoShown(choice: boolean | null, realCount: number | null): boolean {
  return choice ?? realCount === 0
}

export function useQuoteDemo(realCount: number | null): { on: boolean; setOn: (on: boolean) => void } {
  const { user } = useAuth()
  const key = quoteDemoKey(user?.email)
  const [state, setState] = useState<{ key: string; choice: boolean | null }>(() => ({ key, choice: readDemoChoice(key) }))
  let current = state
  // A different user signing in on the same browser gets their own choice.
  if (state.key !== key) {
    current = { key, choice: readDemoChoice(key) }
    setState(current)
  }
  const setOn = useCallback((on: boolean) => {
    writeDemoChoice(key, on)
    setState({ key, choice: on })
  }, [key])
  return { on: demoShown(current.choice, realCount), setOn }
}
