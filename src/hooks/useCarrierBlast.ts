import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  listCarrierContacts,
  listCarrierCampaigns,
  listCarrierReplies,
  updateCarrierContact,
  updateCarrierCampaign,
  updateCarrierReply,
  createCarrierCampaign,
  carrierBlast,
  batchCreateCarrierContacts,
} from '@/lib/apiClient'
import type { CarrierContact, CarrierCampaign, CarrierReply, CarrierLane } from '@/types'
import type { CarrierCapacity } from '@/lib/apiClient'

const POLL_MS = 30_000

// ── Contacts ──────────────────────────────────────────────────────────────────

export function useCarrierContacts(lane: CarrierLane) {
  const [items, setItems] = useState<CarrierContact[]>([])
  // Derived: true until a fetch for the CURRENT lane has settled.
  const [loadedLane, setLoadedLane] = useState<CarrierLane | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() =>
    listCarrierContacts(lane)
      .then((next) => { setItems(next) })
      .catch((err: unknown) => {
        console.error('[useCarrierContacts] fetch error', err)
        toast.error(`Couldn't load ${lane} contacts`)
      })
      .finally(() => setLoadedLane(lane)),
  [lane])
  const refresh = useCallback(() => { setLoadedLane(null); return load() }, [load])

  useEffect(() => {
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const loading = loadedLane !== lane

  const importContacts = useCallback(async (
    contacts: Omit<CarrierContact, 'id' | 'createdAt' | 'updatedAt'>[]
  ) => {
    setSaving(true)
    try {
      const created = await batchCreateCarrierContacts(contacts)
      setItems((prev) => [...prev, ...created])
      toast.success(`Imported ${created.length} contact${created.length === 1 ? '' : 's'}`)
      return created
    } catch (err) {
      toast.error(`Couldn't import contacts: ${err instanceof Error ? err.message : 'unknown error'}`)
      throw err
    } finally {
      setSaving(false)
    }
  }, [])

  const setStatus = useCallback(async (id: string, status: CarrierContact['status']) => {
    try {
      const updated = await updateCarrierContact(id, { status })
      setItems((prev) => prev.map((c) => (c.id === id ? updated : c)))
      return updated
    } catch (err) {
      toast.error(`Couldn't update contact: ${err instanceof Error ? err.message : 'unknown error'}`)
      throw err
    }
  }, [])

  const counts = useMemo(() => ({
    active: items.filter((c) => c.status === 'active').length,
    bounced: items.filter((c) => c.status === 'bounced').length,
    unsubscribed: items.filter((c) => c.status === 'unsubscribed').length,
    removed: items.filter((c) => c.status === 'removed').length,
  }), [items])

  return { items, counts, loading, saving, refresh, importContacts, setStatus }
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

export function useCarrierCampaigns() {
  const [items, setItems] = useState<CarrierCampaign[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(() =>
    listCarrierCampaigns()
      .then((next) => { setItems(next) })
      .catch((err: unknown) => {
        console.error('[useCarrierCampaigns] fetch error', err)
        toast.error("Couldn't load campaigns")
      })
      .finally(() => setLoading(false)),
  [])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => {
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const addCampaign = useCallback(async (
    input: Omit<CarrierCampaign, 'id' | 'createdAt' | 'updatedAt'>
  ) => {
    try {
      const created = await createCarrierCampaign(input)
      setItems((prev) => [created, ...prev])
      toast.success('Campaign saved as draft')
      return created
    } catch (err) {
      toast.error(`Couldn't save campaign: ${err instanceof Error ? err.message : 'unknown error'}`)
      throw err
    }
  }, [])

  const patchCampaign = useCallback(async (id: string, patch: Partial<CarrierCampaign>) => {
    try {
      const updated = await updateCarrierCampaign(id, patch)
      setItems((prev) => prev.map((c) => (c.id === id ? updated : c)))
      return updated
    } catch (err) {
      toast.error(`Couldn't update campaign: ${err instanceof Error ? err.message : 'unknown error'}`)
      throw err
    }
  }, [])

  const runAction = useCallback(async (
    id: string,
    action: 'launchCampaign' | 'pauseCampaign' | 'resumeCampaign' | 'syncCampaign'
  ) => {
    const res = await carrierBlast(action, { campaignId: id })
    if (!res.ok) throw new Error(res.error ?? 'action failed')
    await load()
    return res
  }, [load])

  return { items, loading, refresh, addCampaign, patchCampaign, runAction }
}

// ── Replies ───────────────────────────────────────────────────────────────────

export interface CarrierReplyFilter {
  status?: CarrierReply['status']
  campaignId?: string | null
  lane?: CarrierLane | null
}

export function useCarrierReplies(filter?: CarrierReplyFilter) {
  const { status, campaignId, lane } = filter ?? {}
  const key = `${status ?? ''}|${campaignId ?? ''}|${lane ?? ''}`
  const [items, setItems] = useState<CarrierReply[]>([])
  // Derived: true until a fetch for the CURRENT filter has settled.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const load = useCallback(() =>
    listCarrierReplies({ status, campaignId, lane })
      .then((next) => { setItems(next) })
      .catch((err: unknown) => {
        console.error('[useCarrierReplies] fetch error', err)
        toast.error("Couldn't load replies")
      })
      .finally(() => setLoadedKey(key)),
  [status, campaignId, lane, key])
  const refresh = useCallback(() => { setLoadedKey(null); return load() }, [load])

  useEffect(() => {
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const loading = loadedKey !== key

  const setStatus = useCallback(async (id: string, status: CarrierReply['status'], handledBy?: string) => {
    const patch: Partial<CarrierReply> = { status }
    if (status === 'handled') {
      patch.handledBy = handledBy ?? null
      patch.handledAt = new Date().toISOString()
    } else {
      patch.handledBy = null
      patch.handledAt = null
    }
    try {
      const updated = await updateCarrierReply(id, patch)
      setItems((prev) => prev.map((r) => (r.id === id ? updated : r)))
      return updated
    } catch (err) {
      toast.error(`Couldn't update reply: ${err instanceof Error ? err.message : 'unknown error'}`)
      throw err
    }
  }, [])

  const setAssignedTo = useCallback(async (id: string, assignedTo: string | null) => {
    try {
      const updated = await updateCarrierReply(id, { assignedTo })
      setItems((prev) => prev.map((r) => (r.id === id ? updated : r)))
      return updated
    } catch (err) {
      toast.error(`Couldn't assign reply: ${err instanceof Error ? err.message : 'unknown error'}`)
      throw err
    }
  }, [])

  const sendReply = useCallback(async (replyId: string, bodyText: string) => {
    const res = await carrierBlast('sendReply', { replyId, bodyText })
    if (!res.ok) throw new Error(res.error ?? 'reply failed')
    return res
  }, [])

  return { items, loading, refresh, setStatus, setAssignedTo, sendReply }
}

// ── Live capacity ─────────────────────────────────────────────────────────────

const CAPACITY_NORMAL_MS = 60_000
const CAPACITY_ERROR_MS = 5 * 60_000

export interface UseCarrierCapacityResult {
  capacity: CarrierCapacity | null
  loading: boolean
  error: Error | null
  refresh: (force?: boolean) => void
}

export function useCarrierCapacity(): UseCarrierCapacityResult {
  const [capacity, setCapacity] = useState<CarrierCapacity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [intervalMs, setIntervalMs] = useState(CAPACITY_NORMAL_MS)

  const load = useCallback((force?: boolean) =>
    carrierBlast('capacity', force ? { refresh: true } : undefined)
      .then((res) => {
        if (!res.ok) throw new Error(res.error ?? 'capacity failed')
        setCapacity(res as unknown as CarrierCapacity)
        setError(null)
        setIntervalMs(CAPACITY_NORMAL_MS)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)))
        setIntervalMs(CAPACITY_ERROR_MS)
      })
      .finally(() => setLoading(false)),
  [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const id = setInterval(() => load(), intervalMs)
    return () => clearInterval(id)
  }, [load, intervalMs])

  const refresh = useCallback((force?: boolean) => {
    setIntervalMs(CAPACITY_NORMAL_MS)
    setLoading(true)
    void load(force)
  }, [load])

  return { capacity, loading, error, refresh }
}
