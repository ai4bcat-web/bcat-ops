import { useCallback, useEffect, useRef, useState } from 'react'
import { useZipAutofill } from '@/hooks/useZipAutofill'
import type { CityOption, ZipPlace } from '@/lib/zipLookup'

export interface AddressPatch { city?: string; state?: string; zip?: string }

/** What picking a place in the city type-ahead writes: its city and state, and its ZIP only when none is typed. */
export function addressPickPatch(option: CityOption, currentZip: string | null | undefined, upper = false): AddressPatch {
  const patch: AddressPatch = { city: upper ? option.city.toUpperCase() : option.city, state: option.state }
  if (!(currentZip ?? '').trim()) patch.zip = option.zip
  return patch
}

/**
 * One address autofill for every form that edits a city, state and ZIP (Ryne 2026-11-16: "zips auto populate as we type
 * in cities and vice versa ... anywhere in the whole bcat ops"):
 *  - a complete ZIP fills a BLANK city and state (useZipAutofill; nothing typed is ever overwritten);
 *  - picking a place in the city type-ahead (CityInput) fills its state, and its ZIP when the ZIP is blank.
 * `hint` says what was filled ("Auto-filled …") for a few seconds; show it under the fields.
 * `upper` writes the city in capitals, the way loads and stops store it; directory forms leave it as the table spells it.
 */
export function useAddressAutofill(opts: {
  zip: string | null | undefined
  city: string | null | undefined
  state: string | null | undefined
  apply: (patch: AddressPatch) => void
  upper?: boolean
}): { hint: string | null; pickCity: (option: CityOption) => void } {
  const { zip, city, state, apply, upper = false } = opts
  const [hint, setHint] = useState<string | null>(null)
  const latest = useRef({ zip, apply, upper })
  useEffect(() => { latest.current = { zip, apply, upper } })
  const casing = (c: string) => (latest.current.upper ? c.toUpperCase() : c)

  useZipAutofill(zip, city, state, (found: Partial<ZipPlace>) => {
    const patch: AddressPatch = {}
    if (found.city) patch.city = casing(found.city)
    if (found.state) patch.state = found.state
    if (!patch.city && !patch.state) return
    latest.current.apply(patch)
    setHint(`Auto-filled ${[patch.city, patch.state].filter(Boolean).join(', ')} from ZIP ${latest.current.zip ?? ''}`.trim())
  })

  const pickCity = useCallback((option: CityOption) => {
    // A ZIP already typed stays; a blank one takes the picked place's ZIP.
    const patch = addressPickPatch(option, latest.current.zip, latest.current.upper)
    latest.current.apply(patch)
    setHint(`Auto-filled ${patch.zip ? `ZIP ${patch.zip} and ` : ''}state ${option.state}`)
  }, [])

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(null), 7000)
    return () => clearTimeout(timer)
  }, [hint])

  return { hint, pickCity }
}
