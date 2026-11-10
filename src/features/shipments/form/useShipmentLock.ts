/**
 * The edit-form side of the 10-minute shipment lock: take it when the form opens on an existing shipment, refresh it while the form
 * stays open, release it when the person leaves (save and exit, cancel, close the tab). Someone else holding it comes back as `heldBy`.
 */
import { useEffect, useState } from 'react'
import { lockShipment, unlockShipment } from '@/lib/apiClient'
import { LOCK_REFRESH_MS } from '@/lib/shipmentLock'

export function useShipmentLock(shipmentId: string | null | undefined): { heldBy: { by: string; until: string } | null } {
  const [heldBy, setHeldBy] = useState<{ by: string; until: string } | null>(null)
  useEffect(() => {
    if (!shipmentId) return undefined
    let alive = true
    let mine = false
    const take = () => lockShipment(shipmentId)
      .then((r) => {
        if (!alive) return
        mine = r.locked
        setHeldBy(r.locked ? null : { by: r.lockedBy ?? 'Someone', until: r.expiresAt ?? '' })
      })
      .catch(() => { /* a lock that cannot be taken must never stop the person working */ })
    void take()
    const timer = setInterval(() => { void take() }, LOCK_REFRESH_MS)
    const release = () => { if (mine) void unlockShipment(shipmentId).catch(() => undefined) }
    window.addEventListener('pagehide', release)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('pagehide', release)
      release()
    }
  }, [shipmentId])
  return { heldBy }
}
