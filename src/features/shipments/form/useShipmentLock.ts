/**
 * The edit-form side of the 10-minute shipment lock: take it when the form opens on an existing shipment and refresh it while the person
 * is working in it. A plain Save keeps it while the form stays open. Leaving the form in any way (Save & exit, Discard, back, another page)
 * or closing the tab lets go at once. A form left open and untouched for LOCK_IDLE_MS lets go too (the next refresh tick releases instead
 * of renewing), so a forgotten tab cannot hold a shipment; coming back to it takes the lock again. Someone else holding it comes back
 * as `heldBy`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { lockShipment, unlockShipment } from '@/lib/apiClient'
import { LOCK_IDLE_MS, LOCK_REFRESH_MS } from '@/lib/shipmentLock'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

export function useShipmentLock(shipmentId: string | null | undefined): { heldBy: { by: string; until: string } | null; release: () => Promise<void> } {
  const [heldBy, setHeldBy] = useState<{ by: string; until: string } | null>(null)
  const mineRef = useRef(false)
  useEffect(() => {
    if (!shipmentId) return undefined
    let alive = true
    let lastActive = Date.now()
    let idleReleased = false
    const take = () => lockShipment(shipmentId)
      .then((r) => {
        if (!alive) return
        mineRef.current = r.locked
        setHeldBy(r.locked ? null : { by: r.lockedBy ?? 'Someone', until: r.expiresAt ?? '' })
      })
      .catch(() => { /* a lock that cannot be taken must never stop the person working */ })
    void take()
    const tick = () => {
      if (Date.now() - lastActive > LOCK_IDLE_MS) {
        // Left open and untouched: let go instead of renewing.
        if (mineRef.current) { mineRef.current = false; idleReleased = true; void unlockShipment(shipmentId).catch(() => undefined) }
        return
      }
      void take()
    }
    const timer = setInterval(tick, LOCK_REFRESH_MS)
    const onActivity = () => {
      lastActive = Date.now()
      if (idleReleased) { idleReleased = false; void take() }
    }
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onActivity)
    const release = () => { if (mineRef.current) void unlockShipment(shipmentId).catch(() => undefined) }
    window.addEventListener('pagehide', release)
    return () => {
      alive = false
      clearInterval(timer)
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity)
      document.removeEventListener('visibilitychange', onActivity)
      window.removeEventListener('pagehide', release)
      // Leaving the form (back, another page, another shipment) lets go: the timer is only for a form left open.
      release()
      mineRef.current = false
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
