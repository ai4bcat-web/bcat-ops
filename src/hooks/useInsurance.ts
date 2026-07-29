import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import {
  listInsurancePeriods, listInsuranceLineItems,
  createInsurancePeriod, updateInsurancePeriod, deleteInsurancePeriod, setCurrentPeriod,
  createInsuranceLineItem, updateInsuranceLineItem, deleteInsuranceLineItem, cloneLineItems,
  type InsurancePeriod, type InsuranceLineItem, type InsuranceKind,
} from '@/lib/insuranceClient'
import type { Equipment } from '@/types/equipment'

export interface CategoryTotals { truckCents: number; trailerCents: number; wcCents: number; totalCents: number }

/** One row in the per-truck / per-trailer editor: a live equipment unit joined to its line item. */
export interface UnitRow {
  key: string
  equipment?: Equipment
  unitNumber: string
  item?: InsuranceLineItem
  annualCents: number
  orphaned: boolean   // a line item whose equipment no longer exists in the fleet
}

export interface CategoryDelta { a: number; b: number; delta: number; pct: number | null }
export interface UnitDelta { key: string; unitNumber: string; kind: InsuranceKind; a: number; b: number; delta: number }
export interface Comparison {
  truck: CategoryDelta; trailer: CategoryDelta; wc: CategoryDelta; total: CategoryDelta
  units: UnitDelta[]
}

function delta(a: number, b: number): CategoryDelta {
  return { a, b, delta: b - a, pct: a === 0 ? null : ((b - a) / a) * 100 }
}

export function useInsurance() {
  const equipment = useAppStore((s) => s.equipment)
  const [periods, setPeriods] = useState<InsurancePeriod[]>([])
  const [items, setItems] = useState<InsuranceLineItem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [p, i] = await Promise.all([listInsurancePeriods(), listInsuranceLineItems()])
    setPeriods(p.sort((a, b) => (a.label < b.label ? 1 : -1)))  // newest label first
    setItems(i)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    refresh()
      .catch((e) => console.error('[insurance] load', e))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])

  const trucks = useMemo(() => equipment.filter((e) => e.type === 'truck'), [equipment])
  const trailers = useMemo(() => equipment.filter((e) => e.type === 'trailer'), [equipment])

  const currentPeriod = useMemo(
    () => periods.find((p) => p.isCurrent) ?? periods[0] ?? null,
    [periods],
  )

  const itemsFor = useCallback((periodId: string) => items.filter((i) => i.periodId === periodId), [items])

  const summary = useCallback((periodId: string): CategoryTotals => {
    const list = itemsFor(periodId)
    const truckCents = list.filter((i) => i.kind === 'TRUCK').reduce((s, i) => s + (i.annualCents || 0), 0)
    const trailerCents = list.filter((i) => i.kind === 'TRAILER').reduce((s, i) => s + (i.annualCents || 0), 0)
    const wcCents = list.filter((i) => i.kind === 'WORKMANS_COMP').reduce((s, i) => s + (i.annualCents || 0), 0)
    return { truckCents, trailerCents, wcCents, totalCents: truckCents + trailerCents + wcCents }
  }, [itemsFor])

  /** Per-unit rows: every live unit of `kind`, joined to its line item, plus any orphaned items. */
  const unitRows = useCallback((periodId: string, kind: 'TRUCK' | 'TRAILER'): UnitRow[] => {
    const fleet = kind === 'TRUCK' ? trucks : trailers
    const list = itemsFor(periodId).filter((i) => i.kind === kind)
    const byEquip = new Map(list.filter((i) => i.equipmentId).map((i) => [i.equipmentId as string, i]))
    const rows: UnitRow[] = fleet.map((e) => {
      const item = byEquip.get(e.id)
      return { key: e.id, equipment: e, unitNumber: e.unitNumber, item, annualCents: item?.annualCents ?? 0, orphaned: false }
    })
    // Line items whose equipment is gone (truck sold/removed) — still real spend on the policy.
    const liveIds = new Set(fleet.map((e) => e.id))
    for (const i of list) {
      if (i.equipmentId && !liveIds.has(i.equipmentId)) {
        rows.push({ key: i.id, unitNumber: i.unitNumber || '—', item: i, annualCents: i.annualCents, orphaned: true })
      }
    }
    return rows.sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
  }, [trucks, trailers, itemsFor])

  const wcItem = useCallback((periodId: string) => itemsFor(periodId).find((i) => i.kind === 'WORKMANS_COMP') ?? null, [itemsFor])

  // ── Comparison (period over period) ──
  const compare = useCallback((aId: string, bId: string): Comparison => {
    const sa = summary(aId), sb = summary(bId)
    const unitMap = new Map<string, UnitDelta>()
    const add = (periodId: string, side: 'a' | 'b') => {
      for (const i of itemsFor(periodId)) {
        if (i.kind === 'WORKMANS_COMP') continue
        const key = i.equipmentId || `${i.kind}:${i.unitNumber}`
        const cur = unitMap.get(key) ?? { key, unitNumber: i.unitNumber || '—', kind: i.kind, a: 0, b: 0, delta: 0 }
        cur[side] = i.annualCents
        unitMap.set(key, cur)
      }
    }
    add(aId, 'a'); add(bId, 'b')
    const units = [...unitMap.values()]
      .map((u) => ({ ...u, delta: u.b - u.a }))
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    return {
      truck: delta(sa.truckCents, sb.truckCents),
      trailer: delta(sa.trailerCents, sb.trailerCents),
      wc: delta(sa.wcCents, sb.wcCents),
      total: delta(sa.totalCents, sb.totalCents),
      units,
    }
  }, [summary, itemsFor])

  // ── Mutations (all refresh) ──
  const addPeriod = useCallback(async (label: string, opts?: { startDate?: string; endDate?: string; makeCurrent?: boolean }) => {
    const p = await createInsurancePeriod({ label, startDate: opts?.startDate, endDate: opts?.endDate, isCurrent: opts?.makeCurrent })
    if (opts?.makeCurrent) await setCurrentPeriod(p.id, [...periods, p])
    await refresh()
    return p
  }, [periods, refresh])

  const renamePeriod = useCallback(async (id: string, patch: Partial<Pick<InsurancePeriod, 'label' | 'startDate' | 'endDate' | 'notes'>>) => {
    await updateInsurancePeriod(id, patch); await refresh()
  }, [refresh])

  const removePeriod = useCallback(async (id: string) => {
    await Promise.all(itemsFor(id).map((i) => deleteInsuranceLineItem(i.id)))
    await deleteInsurancePeriod(id); await refresh()
  }, [itemsFor, refresh])

  const makeCurrent = useCallback(async (id: string) => {
    await setCurrentPeriod(id, periods); await refresh()
  }, [periods, refresh])

  /** Create a new period pre-filled with the current period's amounts, so only changes need editing. */
  const startPeriodFrom = useCallback(async (sourceId: string, label: string, makeCurrentFlag = true) => {
    const p = await createInsurancePeriod({ label, isCurrent: makeCurrentFlag })
    await cloneLineItems(sourceId, p.id, items)
    if (makeCurrentFlag) await setCurrentPeriod(p.id, [...periods, p])
    await refresh()
    return p
  }, [items, periods, refresh])

  /** Upsert a truck/trailer's annual amount for a period. */
  const setUnitAmount = useCallback(async (periodId: string, kind: 'TRUCK' | 'TRAILER', equipmentId: string, unitNumber: string, annualCents: number) => {
    const existing = itemsFor(periodId).find((i) => i.kind === kind && i.equipmentId === equipmentId)
    if (existing) await updateInsuranceLineItem(existing.id, { annualCents, unitNumber })
    else await createInsuranceLineItem({ periodId, kind, equipmentId, unitNumber, annualCents })
    await refresh()
  }, [itemsFor, refresh])

  /** Upsert the single workmans-comp total for a period. */
  const setWcAmount = useCallback(async (periodId: string, annualCents: number) => {
    const existing = wcItem(periodId)
    if (existing) await updateInsuranceLineItem(existing.id, { annualCents })
    else await createInsuranceLineItem({ periodId, kind: 'WORKMANS_COMP', annualCents })
    await refresh()
  }, [wcItem, refresh])

  const removeLineItem = useCallback(async (id: string) => {
    await deleteInsuranceLineItem(id); await refresh()
  }, [refresh])

  return {
    loading, periods, currentPeriod, trucks, trailers,
    summary, unitRows, wcItem, compare,
    addPeriod, renamePeriod, removePeriod, makeCurrent, startPeriodFrom,
    setUnitAmount, setWcAmount, removeLineItem, refresh,
  }
}
