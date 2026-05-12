import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Driver, Load, AuditLogEntry, ViewMode, EntityType, AuditAction } from '@/types'
import { getMondayOf } from '@/lib/date'
import * as api from '@/lib/apiClient'

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

      viewMode: 'work-week' as ViewMode,
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
          set({ isLoading: false, error: String(err) })
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
        const after = await api.updateDriver(id, { ...patch, updatedAt: nowIso() })
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
        const after = await api.updateLoad(id, {
          ...patch,
          updatedBy: get().currentUserEmail,
          updatedAt: nowIso(),
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
      name: 'bcat-ops-ui-v2',
      // Only persist UI preferences — data comes from the API
      partialize: (s) => ({
        viewMode: s.viewMode,
        weekStart: s.weekStart,
        filters: s.filters,
      }),
    }
  )
)
