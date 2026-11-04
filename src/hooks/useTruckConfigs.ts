/**
 * Steps AJ/AK — TruckConfig rows by truck id, shared by every surface that shows a work phone
 * (Fleet, the Settings gap card, the tracking strip, the driver views).
 *
 * One cached read (`cachedList`) for all mounted copies. `upsert` merges the saved row into the
 * cache and tells every mounted copy at once, so an edit on Fleet is visible in the Settings
 * card without a refetch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listTruckConfigs, upsertTruckConfig, type TruckConfig } from '@/lib/apiClient'
import { cachedList, peekList, putList } from '@/lib/listCache'
import { workPhoneFor, type DriverPhoneRecord, type DriverPhones } from '@/lib/workPhone'

const KEY = 'directory:truckConfigs'
const OPTS = { ttlMs: 60_000 }

type UpsertInput = Parameters<typeof upsertTruckConfig>[0]
const listeners = new Set<(rows: TruckConfig[]) => void>()

function publish(rows: TruckConfig[]): void {
  putList(KEY, rows)
  listeners.forEach((fn) => fn(rows))
}

export interface TruckConfigs {
  byId: ReadonlyMap<string, TruckConfig>
  loading: boolean
  refresh: () => Promise<void>
  /** Saves and merges the returned row into every mounted copy. Optimistic; rolled back and rethrown on error. */
  upsert: (input: UpsertInput) => Promise<TruckConfig>
}

export function useTruckConfigs(): TruckConfigs {
  const [rows, setRows] = useState<TruckConfig[] | undefined>(() => peekList<TruckConfig[]>(KEY))

  useEffect(() => {
    listeners.add(setRows)
    return () => { listeners.delete(setRows) }
  }, [])

  useEffect(() => {
    let live = true
    cachedList(KEY, listTruckConfigs, OPTS)
      .then((fresh) => { if (live) setRows(fresh) })
      .catch((err: unknown) => { console.error('[useTruckConfigs] load failed:', err) })
    return () => { live = false }
  }, [])

  const refresh = useCallback(async () => {
    publish(await cachedList(KEY, listTruckConfigs, { ...OPTS, force: true }))
  }, [])

  const upsert = useCallback(async (input: UpsertInput): Promise<TruckConfig> => {
    const before = peekList<TruckConfig[]>(KEY) ?? []
    const existing = before.find((r) => r.truckId === input.truckId)
    const optimistic = { createdAt: '', updatedAt: '', ...existing, ...input } as TruckConfig
    publish([...before.filter((r) => r.truckId !== input.truckId), optimistic])
    try {
      const saved = await upsertTruckConfig(input)
      publish([...(peekList<TruckConfig[]>(KEY) ?? before).filter((r) => r.truckId !== input.truckId), saved])
      return saved
    } catch (err) {
      publish(before)
      throw err
    }
  }, [])

  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.truckId, r])), [rows])
  return { byId, loading: rows === undefined, refresh, upsert }
}

/** The work and personal numbers for one driver on one load (or their assigned truck). */
export function useDriverPhones(
  driver: DriverPhoneRecord | null | undefined,
  opts?: { loadTruckId?: string | null; legDriverPhone?: string | null; unitNumber?: string | null },
): DriverPhones {
  const { byId } = useTruckConfigs()
  const loadTruckId = opts?.loadTruckId
  const legDriverPhone = opts?.legDriverPhone
  const unitNumber = opts?.unitNumber
  return useMemo(
    () => workPhoneFor({ driver, loadTruckId, legDriverPhone, unitNumber, truck: (id) => byId.get(id) }),
    [driver, loadTruckId, legDriverPhone, unitNumber, byId],
  )
}
