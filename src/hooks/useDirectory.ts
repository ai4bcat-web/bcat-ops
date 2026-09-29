import { useState, useEffect, useCallback } from 'react'
import {
  listCustomers, createCustomer, updateCustomer, archiveCustomer,
  listLocations, createLocation, updateLocation, archiveLocation,
} from '@/lib/apiClient'
import type { CustomerRecord, LocationRecord } from '@/types/tms'

export type { CustomerRecord, LocationRecord }

const byName = <T extends { name: string }>(rows: T[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name))

/**
 * The customer & location directory — the reusable address book behind the Load form.
 * One hook for both lists; either page (and the drawer's pickers) reads it. A failed
 * load is reported through `error`, never rendered as an empty directory.
 */
export function useDirectory(opts?: { includeArchived?: boolean }) {
  const includeArchived = opts?.includeArchived ?? false
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [locations, setLocations] = useState<LocationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // No synchronous setState before the first await (react-hooks/set-state-in-effect):
  // every state write lives in the promise chain. `refresh` sets loading itself.
  const load = useCallback(() =>
    Promise.all([listCustomers({ includeArchived }), listLocations({ includeArchived })])
      .then(([c, l]) => { setCustomers(byName(c)); setLocations(byName(l)); setError(null) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Directory failed to load') })
      .finally(() => setLoading(false)),
  [includeArchived])
  useEffect(() => { load() }, [load])
  const refresh = useCallback(() => { setLoading(true); return load() }, [load])
  const replaceCustomer = (c: CustomerRecord) =>
    setCustomers((p) => byName(p.some((x) => x.id === c.id) ? p.map((x) => (x.id === c.id ? c : x)) : [...p, c]))
  const replaceLocation = (l: LocationRecord) =>
    setLocations((p) => byName(p.some((x) => x.id === l.id) ? p.map((x) => (x.id === l.id ? l : x)) : [...p, l]))

  return {
    customers, locations, loading, error, refresh,
    addCustomer: async (input: Parameters<typeof createCustomer>[0]) => {
      const c = await createCustomer(input); replaceCustomer(c); return c
    },
    /** `current` is the record the form was opened from — its updatedAt is the CAS token. */
    saveCustomer: async (current: CustomerRecord, patch: Parameters<typeof updateCustomer>[1]) => {
      const c = await updateCustomer(current.id, patch, current.updatedAt); replaceCustomer(c); return c
    },
    archiveCustomer: async (current: CustomerRecord) => {
      const c = await archiveCustomer(current.id, current.updatedAt)
      if (includeArchived) replaceCustomer(c); else setCustomers((p) => p.filter((x) => x.id !== c.id))
      return c
    },
    addLocation: async (input: Parameters<typeof createLocation>[0]) => {
      const l = await createLocation(input); replaceLocation(l); return l
    },
    saveLocation: async (current: LocationRecord, patch: Parameters<typeof updateLocation>[1]) => {
      const l = await updateLocation(current.id, patch, current.updatedAt); replaceLocation(l); return l
    },
    archiveLocation: async (current: LocationRecord) => {
      const l = await archiveLocation(current.id, current.updatedAt)
      if (includeArchived) replaceLocation(l); else setLocations((p) => p.filter((x) => x.id !== l.id))
      return l
    },
  }
}
