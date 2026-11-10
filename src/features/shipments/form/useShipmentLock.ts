/**
 * The edit-form side of the 10-minute shipment lock: take it when the form opens on an existing shipment and refresh it while the form
 * stays open. A plain Save keeps it, and so does simply walking away (it then lapses by itself after 10 minutes and shows under
 * "Currently viewing" meanwhile, where its holder can let go of it); `release()` is Save & exit / Discard, and closing the tab also
 * lets go. Someone else holding it comes back as `heldBy`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { lockShipment, unlockShipment } from '@/lib/apiClient'
import { LOCK_REFRESH_MS } from '@/lib/shipmentLock'

export function useShipmentLock(shipmentId: string | null | undefined): { heldBy: { by: string; until: string } | null; release: () => Promise<void> } {
  const [heldBy, setHeldBy] = useState<{ by: string; until: string } | null>(null)
  const mineRef = useRef(false)
  useEffect(() => {
    if (!shipmentId) return undefined
    let alive = true
    const take = () => lockShipment(shipmentId)
      .then((r) => {
        if (!alive) return
        mineRef.current = r.locked
        setHeldBy(r.locked ? null : { by: r.lockedBy ?? 'Someone', until: r.expiresAt ?? '' })
      })
      .catch(() => { /* a lock that cannot be taken must never stop the person working */ })
    void take()
    const timer = setInterval(() => { void take() }, LOCK_REFRESH_MS)
    const release = () => { if (mineRef.current) void unlockShipment(shipmentId).catch(() => undefined) }
    window.addEventListener('pagehide', release)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('pagehide', release)
    }
  }, [shipmentId])
  /** Let go of it now (Save & exit, Discard). The refresh timer has stopped or is about to, so nothing takes it back. */
  const release = useCallback(async () => {
    if (!shipmentId || !mineRef.current) return
    mineRef.current = false
    try { await unlockShipment(shipmentId) } catch { /* it lapses by itself in 10 minutes */ }
  }, [shipmentId])
  return { heldBy, release }
}
