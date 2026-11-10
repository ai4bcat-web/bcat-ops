import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsIconButton } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import { unlockShipment } from '@/lib/apiClient'
import { liveLockOf, type LockFields } from '@/lib/shipmentLock'

interface Row extends LockFields { id: string; number?: string | null }

/**
 * "Currently viewing": the shipments somebody has open for editing right now (a live edit lock), who has each one, and the way out of
 * it. The person holding a lock can let go of it with the x; an admin can let go of anybody's. Shipments nobody has locked are not
 * listed. Used by the Shipments board and by Load Tracking (the same strip, the same words).
 */
export function CurrentlyViewing({ rows, onOpen, onChanged }: { rows: readonly Row[]; onOpen: (id: string) => void; onChanged?: () => void }) {
  const { user, isAdmin } = useAuth()
  const me = (user?.email ?? '').toLowerCase()
  // A lock lapses on its own, so the strip re-reads the clock every 30 s.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const held = rows
    .map((row) => ({ row, lock: liveLockOf(row, now) }))
    .filter((x): x is { row: Row; lock: NonNullable<ReturnType<typeof liveLockOf>> } => x.lock !== null)
  if (held.length === 0) return null

  async function release(id: string, mine: boolean) {
    try {
      const out = await unlockShipment(id, !mine && isAdmin)
      if (!out.released) toast.info('That lock was already gone.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not release the lock')
    } finally {
      onChanged?.()
    }
  }

  return (
    <div className="tms-tracking-recent-row" data-testid="currently-viewing">
      <span className="tms-tracking-recent-label">Currently viewing</span>
      {held.map(({ row, lock }) => {
        const mine = lock.userId.toLowerCase() === me
        const canRelease = mine || isAdmin
        return (
          <span key={row.id} className="tms-tracking-recent-chip" data-testid={`currently-viewing-${row.id}`}>
            <button type="button" className="tms-tracking-recent-pro" onClick={() => onOpen(row.id)} title={`Open ${row.number ?? row.id}`}>
              {row.number ?? row.id}
            </button>
            <span className="tms-muted" style={{ fontSize: 11 }} data-testid="currently-viewing-who">{mine ? 'you' : lock.by}</span>
            {canRelease ? (
              <TmsIconButton shape="plain" aria-label={`Release the lock on ${row.number ?? row.id}`} title="Let go of the lock" onClick={() => void release(row.id, mine)}>
                <X size={10} />
              </TmsIconButton>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
