import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Driver, Load, AuditLogEntry, ViewMode, EntityType, AuditAction } from '@/types'
import type { Truck } from '@/types/truck'
import type { Expense } from '@/types/expense'
import { getMondayOf } from '@/lib/date'
import * as api from '@/lib/apiClient'
import { errorMessage } from '@/lib/utils/errorMessage'

// ── Truck seed data ────────────────────────────────────────────────────────────
const SEED_TRUCKS: Truck[] = [
  { id: 'truck-530', number: '530', make: 'Freightliner', model: 'Cascadia', year: 2019, plate: 'IL-T530', vin: '1FUJGLDR9KSLV8530', active: true, currentDriverId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'truck-685', number: '685', make: 'Kenworth',     model: 'T680',     year: 2020, plate: 'IL-T685', vin: '1XKWD49X1LJ685001', active: true, currentDriverId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'truck-780', number: '780', make: 'Peterbilt',    model: '579',      year: 2021, plate: 'IL-T780', vin: '1XPBD49X6MD780002', active: true, currentDriverId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'truck-299', number: '299', make: 'Freightliner', model: 'Cascadia', year: 2018, plate: 'IL-T299', vin: '1FUJGLDR8JSLV8299', active: true, currentDriverId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
]

// ── Expense seed data ──────────────────────────────────────────────────────────
function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function expId(n: number) { return `exp-${n}` }
function ts(n: number) { return `${daysAgo(n)}T12:00:00Z` }

const SEED_EXPENSES: Expense[] = [
  { id: expId(1),  truckId: 'truck-530', category: 'fuel',        amount: 45000, date: daysAgo(1),  vendor: "Love's Travel Stop",   description: 'Fuel fill-up',      createdAt: ts(1),  updatedAt: ts(1),  createdBy: 'dispatch' },
  { id: expId(2),  truckId: 'truck-685', category: 'fuel',        amount: 52000, date: daysAgo(2),  vendor: 'Pilot Flying J',        description: 'Fuel fill-up',      createdAt: ts(2),  updatedAt: ts(2),  createdBy: 'dispatch' },
  { id: expId(3),  truckId: 'truck-780', category: 'maintenance', amount: 78000, date: daysAgo(3),  vendor: 'Rush Truck Centers',    description: 'Oil change + DEF',  createdAt: ts(3),  updatedAt: ts(3),  createdBy: 'dispatch' },
  { id: expId(4),  truckId: 'truck-299', category: 'fuel',        amount: 41000, date: daysAgo(4),  vendor: 'TA Petro',              description: 'Fuel fill-up',      createdAt: ts(4),  updatedAt: ts(4),  createdBy: 'dispatch' },
  { id: expId(5),  truckId: 'truck-530', category: 'tolls',       amount: 3200,  date: daysAgo(5),  vendor: 'I-Pass',                description: 'Illinois tollway', createdAt: ts(5),  updatedAt: ts(5),  createdBy: 'dispatch' },
  { id: expId(6),  truckId: 'truck-685', category: 'maintenance', amount: 62000, date: daysAgo(7),  vendor: 'Speedco',               description: 'Tire rotation',     createdAt: ts(7),  updatedAt: ts(7),  createdBy: 'dispatch' },
  { id: expId(7),  truckId: 'truck-780', category: 'fuel',        amount: 49000, date: daysAgo(9),  vendor: "Love's Travel Stop",   description: 'Fuel fill-up',      createdAt: ts(9),  updatedAt: ts(9),  createdBy: 'dispatch' },
  { id: expId(8),  truckId: 'truck-299', category: 'maintenance', amount: 28000, date: daysAgo(10), vendor: 'local shop',            description: 'Brake inspection',  createdAt: ts(10), updatedAt: ts(10), createdBy: 'dispatch' },
  { id: expId(9),  truckId: 'truck-530', category: 'fuel',        amount: 53000, date: daysAgo(12), vendor: 'Pilot Flying J',        description: 'Fuel fill-up',      createdAt: ts(12), updatedAt: ts(12), createdBy: 'dispatch' },
  { id: expId(10), truckId: 'truck-685', category: 'fuel',        amount: 47000, date: daysAgo(14), vendor: 'TA Petro',              description: 'Fuel fill-up',      createdAt: ts(14), updatedAt: ts(14), createdBy: 'dispatch' },
  { id: expId(11), truckId: 'truck-780', category: 'insurance',   amount: 120000,date: daysAgo(15), vendor: 'Progressive Commercial', description: 'Monthly premium',  createdAt: ts(15), updatedAt: ts(15), createdBy: 'dispatch' },
  { id: expId(12), truckId: 'truck-299', category: 'fuel',        amount: 38000, date: daysAgo(18), vendor: "Love's Travel Stop",   description: 'Fuel fill-up',      createdAt: ts(18), updatedAt: ts(18), createdBy: 'dispatch' },
  { id: expId(13), truckId: 'truck-530', category: 'maintenance', amount: 95000, date: daysAgo(21), vendor: 'Rush Truck Centers',    description: 'ELD issue repair',  createdAt: ts(21), updatedAt: ts(21), createdBy: 'dispatch' },
  { id: expId(14), truckId: 'truck-685', category: 'tolls',       amount: 2800,  date: daysAgo(23), vendor: 'E-ZPass',               description: 'OH Turnpike',       createdAt: ts(23), updatedAt: ts(23), createdBy: 'dispatch' },
  { id: expId(15), truckId: 'truck-780', category: 'fuel',        amount: 51000, date: daysAgo(28), vendor: 'Pilot Flying J',        description: 'Fuel fill-up',      createdAt: ts(28), updatedAt: ts(28), createdBy: 'dispatch' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowIso(): string { return new Date().toISOString() }
function initWeekStart(): string {
  return getMondayOf(new Date()).toISOString().slice(0, 10)
}

function diffChanges<T extends object>(
  before: Partial<T>,
  after: Partial<T>
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  keys.forEach((k) => {
    const prev = (before as Record<string, unknown>)[k]
    const next = (after as Record<string, unknown>)[k]
    if (prev !== next) changes[k] = { from: prev, to: next }
  })
  return changes
}

// ── State interface ───────────────────────────────────────────────────────────

interface AppState {
  // ── Data (loaded from API) ─────────────────────────────────────────────────
  drivers: Driver[]
  loads: Load[]
  auditLog: AuditLogEntry[]
  isLoading: boolean
  error: string | null
  currentUserEmail: string

  // ── Local data (no backend yet — Zustand only) ─────────────────────────────
  trucks: Truck[]
  expenses: Expense[]

  // ── UI (persisted to localStorage) ────────────────────────────────────────
  viewMode: ViewMode
  weekStart: string
  selectedLoadId: string | null
  drawerMode: 'view' | 'edit' | 'create' | null
  createPreFill: { driverId: string | null; dateStr: string } | null
  filterDriverId: string | null
  searchQuery: string
  filters: { readyToInvoice: boolean; split: boolean; unassigned: boolean }

  // ── Initialization ─────────────────────────────────────────────────────────
  initializeData: (userEmail: string) => Promise<void>
  setCurrentUser: (email: string) => void

  // ── Driver actions ─────────────────────────────────────────────────────────
  addDriver: (d: Omit<Driver, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Driver>
  updateDriver: (id: string, patch: Partial<Omit<Driver, 'id' | 'createdAt'>>) => Promise<void>
  deleteDriver: (id: string) => Promise<void>

  // ── Load actions ───────────────────────────────────────────────────────────
  addLoad: (l: Omit<Load, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateLoad: (id: string, patch: Partial<Omit<Load, 'id' | 'createdAt'>>) => Promise<void>
  deleteLoad: (id: string) => Promise<void>

  // ── Truck actions (local) ──────────────────────────────────────────────────
  addTruck: (t: Omit<Truck, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateTruck: (id: string, patch: Partial<Omit<Truck, 'id' | 'createdAt'>>) => void
  archiveTruck: (id: string) => void

  // ── Expense actions (local) ────────────────────────────────────────────────
  addExpense: (e: Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateExpense: (id: string, patch: Partial<Omit<Expense, 'id' | 'createdAt'>>) => void
  deleteExpense: (id: string) => void

  // ── UI actions ─────────────────────────────────────────────────────────────
  setViewMode: (m: ViewMode) => void
  setWeekStart: (d: string) => void
  setSelectedLoad: (
    id: string | null,
    mode?: 'view' | 'edit' | 'create',
    preFill?: { driverId: string | null; dateStr: string }
  ) => void
  setFilterDriver: (id: string | null) => void
  setSearchQuery: (q: string) => void
  toggleFilter: (f: keyof AppState['filters']) => void
}

// ── Audit helper ──────────────────────────────────────────────────────────────

function writeAudit(
  user: string,
  entityType: EntityType,
  entityId: string,
  action: AuditAction,
  changes: AuditLogEntry['changes']
) {
  // Fire-and-forget — audit log failures shouldn't block the user
  api.createAuditLog({ entityType, entityId, action, user, changes }).catch(() => {})
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ── Initial state ──────────────────────────────────────────────────────
      drivers: [],
      loads: [],
      auditLog: [],
      isLoading: false,
      error: null,
      currentUserEmail: 'dispatch@bcat.local',

      trucks: SEED_TRUCKS,
      expenses: SEED_EXPENSES,

      viewMode: 'week' as ViewMode,
      weekStart: initWeekStart(),
      selectedLoadId: null,
      drawerMode: null,
      createPreFill: null,
      filterDriverId: null,
      searchQuery: '',
      filters: { readyToInvoice: false, split: false, unassigned: false },

      // ── Init ───────────────────────────────────────────────────────────────
      setCurrentUser: (email) => set({ currentUserEmail: email }),

      initializeData: async (userEmail) => {
        set({ isLoading: true, error: null, currentUserEmail: userEmail })
        try {
          const [loads, drivers, auditLog] = await Promise.all([
            api.listLoads(),
            api.listDrivers(),
            api.listAuditLogs(),
          ])
          set({ loads, drivers, auditLog, isLoading: false })
        } catch (err) {
          console.error('[store] initializeData failed', err)
          set({ isLoading: false, error: errorMessage(err) })
        }
      },

      // ── Drivers ────────────────────────────────────────────────────────────
      addDriver: async (d) => {
        const driver = await api.createDriver(d)
        set((s) => ({ drivers: [...s.drivers, driver] }))
        writeAudit(get().currentUserEmail, 'Driver', driver.id, 'create', {
          _snapshot: { from: null, to: driver },
        })
        return driver
      },

      updateDriver: async (id, patch) => {
        const before = get().drivers.find((d) => d.id === id)
        if (!before) return
        // Do NOT pass updatedAt — Amplify Gen 2 manages it server-side.
        // Passing it in UpdateDriverInput causes a GraphQL validation error.
        const after = await api.updateDriver(id, patch)
        set((s) => ({ drivers: s.drivers.map((d) => (d.id === id ? after : d)) }))
        writeAudit(get().currentUserEmail, 'Driver', id, 'update', diffChanges(before, after))
      },

      deleteDriver: async (id) => {
        const before = get().drivers.find((d) => d.id === id)
        if (!before) return
        await api.deleteDriver(id)
        set((s) => ({ drivers: s.drivers.filter((d) => d.id !== id) }))
        writeAudit(get().currentUserEmail, 'Driver', id, 'delete', {
          _snapshot: { from: before, to: null },
        })
      },

      // ── Loads ──────────────────────────────────────────────────────────────
      addLoad: async (l) => {
        const load = await api.createLoad(l)
        set((s) => ({ loads: [...s.loads, load] }))
        writeAudit(get().currentUserEmail, 'Load', load.id, 'create', {
          _snapshot: { from: null, to: load },
        })
      },

      updateLoad: async (id, patch) => {
        const before = get().loads.find((l) => l.id === id)
        if (!before) return
        // Do NOT pass updatedAt — Amplify Gen 2 manages it server-side.
        const after = await api.updateLoad(id, {
          ...patch,
          updatedBy: get().currentUserEmail,
        })
        set((s) => ({ loads: s.loads.map((l) => (l.id === id ? after : l)) }))
        writeAudit(get().currentUserEmail, 'Load', id, 'update', diffChanges(before, after))
      },

      deleteLoad: async (id) => {
        const before = get().loads.find((l) => l.id === id)
        if (!before) return
        await api.deleteLoad(id)
        set((s) => ({ loads: s.loads.filter((l) => l.id !== id) }))
        writeAudit(get().currentUserEmail, 'Load', id, 'delete', {
          _snapshot: { from: before, to: null },
        })
      },

      // ── Trucks ─────────────────────────────────────────────────────────────
      addTruck: (t) => {
        const truck: Truck = { ...t, id: `truck-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() }
        set((s) => ({ trucks: [...s.trucks, truck] }))
      },
      updateTruck: (id, patch) => {
        set((s) => ({ trucks: s.trucks.map((t) => t.id === id ? { ...t, ...patch, updatedAt: nowIso() } : t) }))
      },
      archiveTruck: (id) => {
        set((s) => ({ trucks: s.trucks.map((t) => t.id === id ? { ...t, active: false, updatedAt: nowIso() } : t) }))
      },

      // ── Expenses ───────────────────────────────────────────────────────────
      addExpense: (e) => {
        const expense: Expense = { ...e, id: `exp-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() }
        set((s) => ({ expenses: [...s.expenses, expense] }))
      },
      updateExpense: (id, patch) => {
        set((s) => ({ expenses: s.expenses.map((e) => e.id === id ? { ...e, ...patch, updatedAt: nowIso() } : e) }))
      },
      deleteExpense: (id) => {
        set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }))
      },

      // ── UI ─────────────────────────────────────────────────────────────────
      setViewMode: (m) => set({ viewMode: m }),
      setWeekStart: (d) => set({ weekStart: d }),
      setSelectedLoad: (id, mode = 'view', preFill) =>
        set({
          selectedLoadId: id,
          drawerMode: id === null && mode !== 'create' ? null : mode,
          createPreFill: preFill ?? null,
        }),
      setFilterDriver: (id) => set({ filterDriverId: id }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      toggleFilter: (f) =>
        set((s) => ({ filters: { ...s.filters, [f]: !s.filters[f] } })),
    }),
    {
      name: 'bcat-ops-ui-v3',
      // Only persist UI preferences — data comes from the API
      partialize: (s) => ({
        viewMode: s.viewMode,
        weekStart: s.weekStart,
        filters: s.filters,
      }),
    }
  )
)
