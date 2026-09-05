import { useState, useEffect, useCallback } from 'react'
import {
  listCustomers, createCustomer, updateCustomer, deleteCustomer,
  listLocations, createLocation, updateLocation, deleteLocation,
  type CustomerRecord, type LocationRecord,
} from '@/lib/apiClient'

export type { CustomerRecord, LocationRecord }

/**
 * The customer & location directory — the reusable address book behind the Load form.
 * One hook for both lists; either page (and the drawer's datalists) reads it.
 * Degrades to empty lists until the backend with the models is deployed.
 */
export function useDirectory() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [locations, setLocations] = useState<LocationRecord[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, l] = await Promise.all([
        listCustomers().catch(() => [] as CustomerRecord[]),
        listLocations().catch(() => [] as LocationRecord[]),
      ])
      setCustomers(c.sort((a, b) => a.name.localeCompare(b.name)))
      setLocations(l.sort((a, b) => a.name.localeCompare(b.name)))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  return {
    customers, locations, loading, refresh: load,
    addCustomer: async (input: Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>) => {
      const c = await createCustomer(input); setCustomers((p) => [...p, c].sort((a, b) => a.name.localeCompare(b.name))); return c
    },
    saveCustomer: async (id: string, patch: Partial<Omit<CustomerRecord, 'id' | 'createdAt' | 'updatedAt'>>) => {
      const c = await updateCustomer(id, patch); setCustomers((p) => p.map((x) => x.id === id ? c : x)); return c
    },
    removeCustomer: async (id: string) => { await deleteCustomer(id); setCustomers((p) => p.filter((x) => x.id !== id)) },
    addLocation: async (input: Omit<LocationRecord, 'id' | 'createdAt' | 'updatedAt'>) => {
      const l = await createLocation(input); setLocations((p) => [...p, l].sort((a, b) => a.name.localeCompare(b.name))); return l
    },
    saveLocation: async (id: string, patch: Partial<Omit<LocationRecord, 'id' | 'createdAt' | 'updatedAt'>>) => {
      const l = await updateLocation(id, patch); setLocations((p) => p.map((x) => x.id === id ? l : x)); return l
    },
    removeLocation: async (id: string) => { await deleteLocation(id); setLocations((p) => p.filter((x) => x.id !== id)) },
  }
}
