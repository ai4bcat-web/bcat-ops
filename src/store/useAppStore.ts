import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Driver, Load, AuditLogEntry, ViewMode, EntityType, AuditAction } from '@/types'
import { MOCK_DRIVERS, MOCK_LOADS } from '@/mocks'
import { getMondayOf } from '@/lib/date'

const CURRENT_USER = 'dispatch@bcat.local'

function newId(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

function initWeekStart(): string {
  return getMondayOf(new Date()).toISOString().slice(0, 10)
}

interface AppState {
  // ── Data ──────────────────────────────────────────────────────────────────
  drivers: Driver[]
  loads: Load[]
  auditLog: AuditLogEntry[]

  // ── UI ────────────────────────────────────────────────────────────────────
  viewMode: ViewMode
  weekStart: string
  selectedLoadId: string | null
  drawerMode: 'view' | 'edit' | 'create' | null
  createPreFill: { driverId: string | null; dateStr: string } | null
  filterDriverId: string | null
  searchQuery: string
  filters: { readyToInvoice: boolean; split: boolean; unassigned: boolean }

  // ── Driver actions ────────────────────────────────────────────────────────
  addDriver: (d: Omit<Driver, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateDriver: (id: string, patch: Partial<Omit<Driver, 'id' | 'createdAt'>>) => void
  deleteDriver: (id: string) => void

  // ── Load actions ──────────────────────────────────────────────────────────
  addLoad: (l: Omit<Load, 'id' | 'createdAt' | 'updatedAt'>) => void
  updateLoad: (id: string, patch: Partial<Omit<Load, 'id' | 'createdAt'>>) => void
  deleteLoad: (id: string) => void

  // ── UI actions ────────────────────────────────────────────────────────────
  setViewMode: (m: ViewMode) => void
  setWeekStart: (d: string) => void
  setSelectedLoad: (id: string | null, mode?: 'view' | 'edit' | 'create', preFill?: { driverId: string | null; dateStr: string }) => void
  setFilterDriver: (id: string | null) => void
  setSearchQuery: (q: string) => void
  toggleFilter: (f: keyof AppState['filters']) => void
  resetToMockData: () => void
}

function appendAudit(
  log: AuditLogEntry[],
  entityType: EntityType,
  entityId: string,
  action: AuditAction,
  changes: AuditLogEntry['changes']
): AuditLogEntry[] {
  return [
    { id: newId(), entityType, entityId, action, user: CURRENT_USER, changes, createdAt: nowIso() },
    ...log,
  ]
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

const initialState = () => ({
  drivers: MOCK_DRIVERS,
  loads: MOCK_LOADS,
  auditLog: [] as AuditLogEntry[],
  viewMode: 'work-week' as ViewMode,
  weekStart: initWeekStart(),
  selectedLoadId: null as string | null,
  drawerMode: null as 'view' | 'edit' | 'create' | null,
  createPreFill: null as { driverId: string | null; dateStr: string } | null,
  filterDriverId: null as string | null,
  searchQuery: '',
  filters: { readyToInvoice: false, split: false, unassigned: false },
})

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...initialState(),

      addDriver: (d) => {
        const now = nowIso()
        const driver: Driver = { ...d, id: newId(), createdAt: now, updatedAt: now }
        set((s) => ({
          drivers: [...s.drivers, driver],
          auditLog: appendAudit(s.auditLog, 'Driver', driver.id, 'create', {
            _snapshot: { from: null, to: driver },
          }),
        }))
      },

      updateDriver: (id, patch) => {
        const before = get().drivers.find((d) => d.id === id)
        if (!before) return
        const after: Driver = { ...before, ...patch, updatedAt: nowIso() }
        set((s) => ({
          drivers: s.drivers.map((d) => (d.id === id ? after : d)),
          auditLog: appendAudit(s.auditLog, 'Driver', id, 'update', diffChanges(before, after)),
        }))
      },

      deleteDriver: (id) => {
        const before = get().drivers.find((d) => d.id === id)
        if (!before) return
        set((s) => ({
          drivers: s.drivers.filter((d) => d.id !== id),
          auditLog: appendAudit(s.auditLog, 'Driver', id, 'delete', {
            _snapshot: { from: before, to: null },
          }),
        }))
      },

      addLoad: (l) => {
        const now = nowIso()
        const load: Load = { ...l, id: newId(), createdAt: now, updatedAt: now }
        set((s) => ({
          loads: [...s.loads, load],
          auditLog: appendAudit(s.auditLog, 'Load', load.id, 'create', {
            _snapshot: { from: null, to: load },
          }),
        }))
      },

      updateLoad: (id, patch) => {
        const before = get().loads.find((l) => l.id === id)
        if (!before) return
        const after: Load = { ...before, ...patch, updatedAt: nowIso(), updatedBy: CURRENT_USER }
        set((s) => ({
          loads: s.loads.map((l) => (l.id === id ? after : l)),
          auditLog: appendAudit(s.auditLog, 'Load', id, 'update', diffChanges(before, after)),
        }))
      },

      deleteLoad: (id) => {
        const before = get().loads.find((l) => l.id === id)
        if (!before) return
        set((s) => ({
          loads: s.loads.filter((l) => l.id !== id),
          auditLog: appendAudit(s.auditLog, 'Load', id, 'delete', {
            _snapshot: { from: before, to: null },
          }),
        }))
      },

      setViewMode: (m) => set({ viewMode: m }),
      setWeekStart: (d) => set({ weekStart: d }),
      setSelectedLoad: (id, mode = 'view', preFill) =>
        set({ selectedLoadId: id, drawerMode: id === null && mode !== 'create' ? null : mode, createPreFill: preFill ?? null }),
      setFilterDriver: (id) => set({ filterDriverId: id }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      toggleFilter: (f) => set((s) => ({ filters: { ...s.filters, [f]: !s.filters[f] } })),
      resetToMockData: () => set(initialState()),
    }),
    {
      name: 'bcat-ops-v1',
      partialize: (s) => ({
        drivers: s.drivers,
        loads: s.loads,
        auditLog: s.auditLog,
      }),
    }
  )
)
