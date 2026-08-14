import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  project, runway, SEED_INPUTS, totalCashCents, totalPayablesCents,
  type CashFlowInputs, type Projection, type Runway,
} from '@/lib/cashFlow'
import {
  getCurrentCashFlowInputs, createCashFlowInputs, updateCashFlowInputs,
  listCashFlowWeeks, createCashFlowWeek, deleteCashFlowWeek, isSchemaMissingError,
  type CashFlowWeekRow,
} from '@/lib/cashFlowClient'

/** Strip the persisted record down to the fields the math cares about. */
function toInputs(rec: Partial<CashFlowInputs> & { weekOf: string }): CashFlowInputs {
  return {
    ...SEED_INPUTS,
    ...rec,
    payablesSpreadMonths: rec.payablesSpreadMonths || 1,
    minCashThresholdCents: rec.minCashThresholdCents ?? 0,
  }
}

export interface UseCashFlow {
  inputs: CashFlowInputs
  projection: Projection
  /** How long the cash lasts — the page's headline answer. */
  runway: Runway
  weeks: CashFlowWeekRow[]
  loading: boolean
  saving: boolean
  /** Unsaved edits are pending until `save()` runs. */
  dirty: boolean
  /** Set when the Cash Flow tables aren't in the deployed schema yet. */
  backendMissing: boolean
  error: string | null
  setField: <K extends keyof CashFlowInputs>(key: K, value: CashFlowInputs[K]) => void
  save: () => Promise<void>
  logThisWeek: () => Promise<void>
  removeWeek: (id: string) => Promise<void>
}

/**
 * State for the standalone Cash Flow page.
 *
 * Reads/writes ONLY the two CashFlow* tables. The projection is recomputed locally on
 * every keystroke so the six-month view reacts live, while persistence is explicit —
 * you press Save. That split keeps a half-typed number out of the stored record.
 */
export function useCashFlow(): UseCashFlow {
  const [inputs, setInputs] = useState<CashFlowInputs>(SEED_INPUTS)
  const [recordId, setRecordId] = useState<string | null>(null)
  const [weeks, setWeeks] = useState<CashFlowWeekRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [backendMissing, setBackendMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [rec, rows] = await Promise.all([getCurrentCashFlowInputs(), listCashFlowWeeks()])
        if (!alive) return
        if (rec) { setInputs(toInputs(rec)); setRecordId(rec.id) }
        setWeeks(rows)
      } catch (err) {
        if (!alive) return
        // Not-yet-deployed is an expected state, not a failure worth alarming about —
        // the page still works from the seeded values, it just can't persist.
        if (isSchemaMissingError(err)) setBackendMissing(true)
        else setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const projection = useMemo(() => project(inputs), [inputs])
  const runwayResult = useMemo(() => runway(inputs), [inputs])

  const setField = useCallback(<K extends keyof CashFlowInputs>(key: K, value: CashFlowInputs[K]) => {
    setInputs((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }))
    setDirty(true)
  }, [])

  const save = useCallback(async () => {
    if (backendMissing) return
    setSaving(true)
    setError(null)
    try {
      const rec = recordId
        ? await updateCashFlowInputs(recordId, inputs)
        : await createCashFlowInputs({ ...inputs, notes: null })
      setRecordId(rec.id)
      setDirty(false)
    } catch (err) {
      if (isSchemaMissingError(err)) setBackendMissing(true)
      else setError(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      setSaving(false)
    }
  }, [backendMissing, inputs, recordId])

  /** Append a snapshot of this week's headline figures + the forecast they produced. */
  const logThisWeek = useCallback(async () => {
    if (backendMissing) return
    const row = await createCashFlowWeek({
      weekOf: inputs.weekOf,
      totalCashCents: totalCashCents(inputs),
      ar30Cents: inputs.ar30Cents,
      ar120Cents: inputs.ar120Cents,
      totalPayablesCents: totalPayablesCents(inputs),
      projectedLowCents: projection.lowestClosingCents,
      projectedEndingCents: projection.endingClosingCents,
      runwayMonths: runwayResult.monthsRemaining,
      notes: null,
    })
    setWeeks((prev) => [...prev, row].sort((a, b) => a.weekOf.localeCompare(b.weekOf)))
  }, [backendMissing, inputs, projection, runwayResult])

  const removeWeek = useCallback(async (id: string) => {
    await deleteCashFlowWeek(id)
    setWeeks((prev) => prev.filter((w) => w.id !== id))
  }, [])

  return {
    inputs, projection, runway: runwayResult, weeks, loading, saving, dirty, backendMissing, error,
    setField, save, logThisWeek, removeWeek,
  }
}
