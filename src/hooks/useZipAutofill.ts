import { useEffect, useRef } from 'react'
import { lookupZip, usZip5, zipFill, type ZipPlace } from '@/lib/zipLookup'

/**
 * Typing a complete US ZIP fills a blank city / state. Fields the person typed are never touched
 * (checked again when the lookup lands), an unknown ZIP or failed lookup does nothing, and the
 * form is never blocked: the person simply types city and state.
 */
export function useZipAutofill(
  zip: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
  apply: (fill: Partial<ZipPlace>) => void,
) {
  const latest = useRef({ city, state, apply })
  useEffect(() => { latest.current = { city, state, apply } })
  const zip5 = usZip5(zip)

  // Keyed on the ZIP alone: clearing a city later must not bring the old autofill back.
  useEffect(() => {
    if (!zip5) return
    let live = true
    void lookupZip(zip5).then((found) => {
      if (!live || !found) return
      const fill = zipFill(latest.current, found)
      if (fill.city || fill.state) latest.current.apply(fill)
    })
    return () => { live = false }
  }, [zip5])
}
