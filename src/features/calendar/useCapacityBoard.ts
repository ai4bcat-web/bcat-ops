import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as api from '@/lib/apiClient'
import {
  applyCapacityOp, EMPTY_CAPACITY_BOARD, todayChicagoYmd,
  type CapacityBoard, type CapacityCard, type CapacityOp,
} from '@/lib/capacityBoard'

const POLL_MS = 20_000

/**
 * The Capacity board's data: loaded once, refreshed every 20 seconds while the tab is showing (and the moment it comes back), and
 * changed through one server action per edit. Moves, covers and deletes show at once and are put back if the server refuses; a save
 * waits for the server so the card carries its real id. While a change is in flight a refresh is ignored, so the board never jumps
 * back to an older picture under someone's hand.
 */
export function useCapacityBoard(enabled: boolean, user: string) {
  const [board, setBoard] = useState<CapacityBoard>(EMPTY_CAPACITY_BOARD)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(0)
  const boardRef = useRef(board)
  useEffect(() => { boardRef.current = board }, [board])

  const refresh = useCallback(async () => {
    if (inFlight.current > 0) return
    try {
      const next = await api.getCapacityBoard()
      if (inFlight.current > 0) return
      setBoard(next)
      setError(null)
    } catch (err) {
      console.warn('[capacity] could not read the board', err)
      setError("Couldn't load the capacity board. Reload the page in a minute.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    // The first read is a fetch whose answer sets state after it arrives, not a synchronous cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    let timer = window.setInterval(() => { void refresh() }, POLL_MS)
    const onVisibility = () => {
      window.clearInterval(timer)
      if (document.visibilityState === 'visible') {
        void refresh()
        timer = window.setInterval(() => { void refresh() }, POLL_MS)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [enabled, refresh])

  /** Run one operation. `optimistic` shows the change before the server answers; a refusal puts the board back and says why. */
  const run = useCallback(async (op: CapacityOp, optimistic: boolean): Promise<CapacityCard | null> => {
    const previous = boardRef.current
    inFlight.current += 1
    if (optimistic) {
      try {
        const local = applyCapacityOp(previous, op, { today: todayChicagoYmd(), nowIso: new Date().toISOString(), user, newId: () => `pending-${Date.now()}` })
        setBoard(local.board)
      } catch { /* the server will say why */ }
    }
    try {
      const result = await api.capacityBoardOp(op)
      setBoard(result.board)
      setError(null)
      return result.card
    } catch (err) {
      setBoard(previous)
      toast.error(err instanceof Error ? err.message : 'The capacity board could not be saved')
      return null
    } finally {
      inFlight.current -= 1
    }
  }, [user])

  const save = useCallback((fields: Record<string, unknown>, id?: string) => run({ op: 'save', id, fields }, false), [run])
  const move = useCallback((id: string, fromDay: string, toDay: string) => run({ op: 'move', id, fromDay, toDay }, true), [run])
  const cover = useCallback((id: string) => run({ op: 'cover', id }, true), [run])
  const reopen = useCallback((id: string) => run({ op: 'reopen', id }, true), [run])
  const restore = useCallback((id: string) => run({ op: 'restore', id }, true), [run])
  const remove = useCallback(async (id: string) => {
    const done = await run({ op: 'delete', id }, true)
    if (done) {
      toast('Card deleted', { action: { label: 'Undo', onClick: () => { void restore(id) } }, duration: 8000 })
    }
    return done
  }, [run, restore])

  return { board, loading, error, refresh, save, move, cover, reopen, remove, restore }
}
