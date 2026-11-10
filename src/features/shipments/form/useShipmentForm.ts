/**
 * The form's state (AH-plan §3.3, §7, §8, §9): one values object, dirty flag, issues from
 * `validateForm`, local-draft autosave, and the pipeline runner (one at a time).
 */
import { repForDivision } from '@/lib/divisionSalesRep'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { requiresApptProofs } from '@/lib/apptQueue'
import type { CustomerRecord, ShipmentBundle, TmsSettings, UserProfileRecord } from '@/types/tms'
import { applyCustomerDefaults, emptyValues, syncCarrierSlots, valuesFromBundle, type ShipmentFormValues } from './model'
import type { FormIssue } from './sectionProps'
import { blockingIssues, validateForm, type ValidationLevel } from './validation'
import { deleteDraft, listDrafts, newDraftId, saveDraft, type StoredDraft } from './draftStore'
import {
  runCreate, runEditSave, runSaveDraft, runSubmit, runUploadQueued,
  type PipelineCtx, type PipelineResult, type ResumePoint,
} from './pipelines'

export const AUTOSAVE_MS = 10_000

export type RunKind = 'draft' | 'create' | 'save' | 'submit'

/** A create that made a real DRAFT but did not finish: Retry re-runs only the failed steps. */
export interface PartialFailure {
  shipmentId: string
  number: string
  failedSteps: string[]
  message: string
  resume: ResumePoint
  draftSave: boolean
}

export interface UseShipmentFormOptions {
  email: string
  /** The shipment being edited (null in create mode). */
  initialBundle: ShipmentBundle | null
  customers: CustomerRecord[]
  staff: UserProfileRecord[]
  settings: TmsSettings | null
  /** Everything but what the form itself decides (the picked customer, Batory). */
  pipelineCtx: Omit<PipelineCtx, 'customer' | 'isBatory'>
  prefillCustomerId?: string
  /** Fired when a create-mode run finished and the shipment exists: navigate to its edit URL. */
  onCreated: (bundle: ShipmentBundle) => void
  onSubmitted: (bundle: ShipmentBundle) => void
  /** Create/Submit refused by the client rules: the page expands those sections. */
  onBlocked: (issues: FormIssue[]) => void
}

export function officeLabelOf(staff: UserProfileRecord[], salesRepId: string): string {
  const keys = staff.find((s) => s.id === salesRepId)?.teamKeys ?? []
  return keys.length > 0 ? keys.join(', ') : 'No Office'
}

export function useShipmentForm(opts: UseShipmentFormOptions) {
  const {
    email, initialBundle, customers, staff, settings, pipelineCtx, onCreated, onSubmitted, onBlocked,
  } = opts
  const customerOf = useCallback(
    (id: string) => customers.find((c) => c.id === id) ?? null, [customers],
  )

  const [bundle, setBundle] = useState<ShipmentBundle | null>(initialBundle)
  const [values, setValuesState] = useState<ShipmentFormValues>(() => {
    if (initialBundle) {
      const order = initialBundle.orders[0]
      const customer = order?.customerId ? customerOf(order.customerId) : null
      const rep = initialBundle.shipment.salesRepId ?? ''
      return valuesFromBundle(initialBundle, { customer, officeLabel: officeLabelOf(staff, rep) })
    }
    const base = emptyValues()
    const pre = opts.prefillCustomerId ? customerOf(opts.prefillCustomerId) : null
    return pre ? applyCustomerDefaults(base, pre) : base
  })
  const valuesRef = useRef(values)
  const [dirty, setDirty] = useState(false)
  /** When the local draft was last written (create mode); the action bar's "Last saved". */
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [attempt, setAttempt] = useState<ValidationLevel | null>(null)
  const [busy, setBusy] = useState(false)
  const [partial, setPartial] = useState<PartialFailure | null>(null)
  const inFlight = useRef(false)
  const clientDraftId = useRef(newDraftId())
  const [drafts, setDrafts] = useState<StoredDraft[]>(() => (initialBundle ? [] : listDrafts(email)))

  const pipelineCtxFor = useCallback((v: ShipmentFormValues): PipelineCtx => {
    const c = customerOf(v.customer.id)
    return {
      ...pipelineCtx,
      customer: c,
      isBatory: requiresApptProofs({ customer: c?.name ?? v.customer.typedName, customerApptWorkflow: c?.apptWorkflow ?? null }),
    }
  }, [pipelineCtx, customerOf])

  const mode: 'create' | 'edit' = bundle ? 'edit' : 'create'
  const customer = customerOf(values.customer.id)

  // `update` never changes identity (sections are memoised on their handlers); it reads the
  // latest bundle / directory / staff through this ref.
  const live = useRef<{ bundle: ShipmentBundle | null; customerOf: (id: string) => CustomerRecord | null; staff: UserProfileRecord[]; divisionReps: unknown }>({ bundle, customerOf, staff, divisionReps: settings?.divisionSalesReps ?? null })
  useEffect(() => { live.current = { bundle, customerOf, staff, divisionReps: settings?.divisionSalesReps ?? null } })

  const update = useCallback((fn: (prev: ShipmentFormValues) => ShipmentFormValues) => {
    const { bundle: current, customerOf: customerById, staff: staffRows } = live.current
    const prev = valuesRef.current
    let next = fn(prev)
    if (next === prev) return
    // `carriers[0]` and the legacy slot-0 fields are one thing: whichever side the edit touched wins.
    next = syncCarrierSlots(prev, next)
    if (next.customer.id !== prev.customer.id && !current) {
      next = applyCustomerDefaults(next, next.customer.id ? customerById(next.customer.id) : null)
    }
    // New shipment: the division picks the sales rep (TmsSettings.divisionSalesReps) unless a person already chose another one.
    if (!current && next.ship.revDivision !== prev.ship.revDivision) {
      const map = live.current.divisionReps
      const before = repForDivision(map, prev.ship.revDivision)
      const want = repForDivision(map, next.ship.revDivision)
      if (want && (!next.roles.salesRepId || next.roles.salesRepId === before)) next = { ...next, roles: { ...next.roles, salesRepId: want } }
    }
    if (next.roles.salesRepId !== prev.roles.salesRepId && next.ship.officeLabel === prev.ship.officeLabel) {
      next = { ...next, ship: { ...next.ship, officeLabel: officeLabelOf(staffRows, next.roles.salesRepId) } }
    }
    valuesRef.current = next
    setValuesState(next)
    setDirty(true)
  }, [])
  const getValues = useCallback(() => valuesRef.current, [])

  const reseed = useCallback((next: ShipmentFormValues, isDirty: boolean) => {
    valuesRef.current = next
    setValuesState(next)
    setDirty(isDirty)
  }, [])

  // ── issues: nothing is shown until the first Save/Create/Submit attempt, then live ──
  const issues = useMemo<FormIssue[]>(
    () => (attempt ? validateForm(values, { level: attempt, mode, customer, settings }) : []),
    [attempt, values, mode, customer, settings],
  )

  // ── local draft autosave (create mode, before any server write): at most once per AUTOSAVE_MS while editing,
  // and a last write when the page closes with a pending change ──
  const autosaveTimer = useRef<number | null>(null)
  const flushDraft = useRef<() => void>(() => {})
  useEffect(() => {
    flushDraft.current = () => {
      if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null }
      if (live.current.bundle) return
      saveDraft(email, clientDraftId.current, valuesRef.current)
      setSavedAt(new Date().toISOString())
    }
  }, [email])
  useEffect(() => {
    if (!dirty || bundle || autosaveTimer.current) return
    autosaveTimer.current = window.setTimeout(() => { autosaveTimer.current = null; flushDraft.current() }, AUTOSAVE_MS)
  }, [values, dirty, bundle])
  useEffect(() => () => {
    if (autosaveTimer.current) flushDraft.current()
  }, [])

  const resumeDraft = useCallback((id: string) => {
    const d = drafts.find((x) => x.clientDraftId === id)
    if (!d) return
    clientDraftId.current = d.clientDraftId
    reseed(d.values, true)
    setDrafts((p) => p.filter((x) => x.clientDraftId !== id))
  }, [drafts, reseed])

  const discardDraft = useCallback((id: string) => {
    deleteDraft(email, id)
    setDrafts((p) => p.filter((x) => x.clientDraftId !== id))
  }, [email])

  // ── pipelines ──
  const finish = useCallback(async (kind: RunKind, result: PipelineResult, wasCreate: boolean, draftSave: boolean): Promise<boolean> => {
    const next = result.bundle
    if (next) setBundle(next)
    if (!result.ok) {
      if (next) reseed(valuesRef.current, true)
      if (result.createdShipmentId && next && result.failedSteps.length === 1 && result.failedSteps[0] === 'assignDriver') {
        // Cover owns assignment retries, including relay confirmations and pay overrides.
        setPartial(null)
        deleteDraft(email, clientDraftId.current)
      } else if (result.createdShipmentId && next) {
        setPartial({
          shipmentId: result.createdShipmentId,
          number: next.shipment.number,
          failedSteps: result.failedSteps,
          message: result.message ?? '',
          resume: { shipmentId: result.createdShipmentId, done: result.steps.filter((s) => s.ok).map((s) => s.step) },
          draftSave,
        })
      }
      toast.error(result.message ?? `${result.failedSteps.join(', ') || 'Save'} failed`)
      return false
    }
    setPartial(null)
    if (!next) return false
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null }
    deleteDraft(email, clientDraftId.current)
    const queued = valuesRef.current.docs.queued
    if (queued.length > 0) {
      const steps = await runUploadQueued(valuesRef.current, next)
      const failed = steps.filter((s) => !s.ok)
      if (failed.length > 0) toast.warning(`${failed.length} document${failed.length === 1 ? '' : 's'} did not upload: ${failed[0].message ?? ''}`)
    }
    const rep = next.shipment.salesRepId ?? ''
    const order = next.orders[0]
    reseed(
      valuesFromBundle(next, { customer: order?.customerId ? customerOf(order.customerId) : null, officeLabel: officeLabelOf(staff, rep) }),
      false,
    )
    if (kind === 'submit') onSubmitted(next)
    else if (wasCreate) onCreated(next)
    else toast.success(kind === 'draft' ? 'Draft saved' : 'Changes saved')
    return true
  }, [email, customerOf, staff, reseed, onCreated, onSubmitted])

  /** Resolves true when the save went through (so Save & exit knows it may leave). */
  const run = useCallback(async (kind: RunKind): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      const level: ValidationLevel = kind === 'draft' ? 'draft' : kind === 'submit' ? 'submit' : 'create'
      setAttempt(level)
      const v = valuesRef.current
      const blocking = blockingIssues(validateForm(v, {
        level, mode: bundle ? 'edit' : 'create', customer: customerOf(v.customer.id), settings,
      }))
      if (blocking.length > 0) {
        if (kind === 'draft') toast.info('Kept as a local draft on this browser. Pick a customer to save it to the server.')
        onBlocked(blocking)
        return false
      }
      const pctx = pipelineCtxFor(v)
      const wasCreate = !bundle
      let result: PipelineResult
      if (kind === 'draft') result = await runSaveDraft(v, pctx, bundle)
      else if (kind === 'submit') result = await runSubmit(v, pctx, bundle as ShipmentBundle)
      else if (!bundle) result = await runCreate(v, pctx, { draftSave: false, resume: partial?.resume })
      else result = await runEditSave(v, pctx, bundle)
      return await finish(kind, result, wasCreate, kind === 'draft')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [bundle, customerOf, settings, pipelineCtxFor, partial, finish, onBlocked])

  /** Retry only the steps of a half-created shipment; `CREATE_SHIPMENT` is never called again. */
  const retry = useCallback(async () => {
    if (!partial || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const v = valuesRef.current
      const pctx = pipelineCtxFor(v)
      const result = await runCreate(v, pctx, { draftSave: partial.draftSave, resume: partial.resume })
      await finish(partial.draftSave ? 'draft' : 'create', result, true, partial.draftSave)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [partial, pipelineCtxFor, finish])

  return {
    values, update, getValues, dirty, savedAt, mode, bundle, setBundle, customer,
    issues, attempt, busy, partial, retry,
    drafts, resumeDraft, discardDraft, seedValues: reseed,
    run,
  }
}
