/**
 * Registers what REQS reads (each customer's Load Review list and the org default, boardReqs.ts) for a page that
 * shows REQS without the board: Load Review. The board registers its own from the lists it already holds.
 */
import { useEffect, useMemo, useState } from 'react'
import { useDirectory } from '@/hooks/useDirectory'
import { getTmsSettings } from '@/lib/apiClient'
import type { TmsSettings } from '@/types/tms'
import { setBoardReqSources } from './boardReqs'

export function useBoardReqSources(): void {
  const { customers } = useDirectory({ locations: false })
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => {
    let live = true
    getTmsSettings().then((s) => { if (live) setSettings(s) }).catch(() => {})
    return () => { live = false }
  }, [])
  // Set during render (like the board) so the grid's text, sort and filter see the sources on the first paint.
  useMemo(() => setBoardReqSources({ customers, orgDefault: settings?.reviewRequirements }), [customers, settings])
}
