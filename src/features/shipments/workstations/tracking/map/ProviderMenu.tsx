/**
 * Overflow menu of the map panel: start or stop continuous carrier tracking through a
 * tracking provider (MacroPoint, Trucker Tools, …). Every provider is STUB until a live
 * port and credentials exist, and the menu says so — it never implies live data.
 */
import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { TmsButton } from '@/features/tms/kit'
import { startProviderTracking, stopProviderTracking } from '@/lib/apiClient'
import { PROVIDERS, isApplicable } from '@/lib/integrations/registry'
import { providerLabel } from './mapModel'
import type { LoadCarrierRecord, TrackingLinkRecord } from '@/types/tms'

const TRACKING_PROVIDERS = PROVIDERS.filter((p) => p.category === 'TRACKING' && isApplicable(p) && p.capabilities.includes('track'))

export function ProviderMenu({ leg, active, onChanged }: {
  leg: LoadCarrierRecord | null
  /** The leg's ACTIVE `PROVIDER_TRACK` link, when there is one. */
  active: TrackingLinkRecord | null
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const host = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (host.current && !host.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  // Own-fleet legs are tracked by their ELD; only a brokered leg has a carrier to subscribe.
  if (!leg || leg.kind !== 'CARRIER') return null

  const run = async (work: () => Promise<string>) => {
    setBusy(true)
    try {
      toast.success(await work())
      setOpen(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Provider tracking failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="tms-strip-menu-host" ref={host}>
      <button type="button" className="tms-icon-btn" aria-label="Map options" aria-haspopup="menu" aria-expanded={open}
        data-testid="tracking-map-menu" onClick={() => setOpen(!open)}>
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div className="tms-strip-menu" role="menu" data-testid="tracking-map-menu-panel">
          {active ? (
            <TmsButton size="sm" variant="ghost" disabled={busy} data-testid="provider-stop"
              onClick={() => void run(async () => { await stopProviderTracking({ linkId: active.id }); return 'Provider tracking stopped' })}>
              {providerLabel(active.provider)} · STUB — no live data · Stop
            </TmsButton>
          ) : TRACKING_PROVIDERS.map((p) => (
            <TmsButton key={p.key} size="sm" variant="ghost" disabled={busy} data-testid={`provider-start-${p.key}`}
              onClick={() => void run(async () => (await startProviderTracking({ loadCarrierId: leg.id, provider: p.key })).message)}>
              Start {p.label} tracking (STUB)
            </TmsButton>
          ))}
        </div>
      )}
    </span>
  )
}
