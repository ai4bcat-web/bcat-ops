/**
 * Create / edit shipment with Aljex's twelve sections (AH-plan §3-§9). Route element for
 * `/tms/shipments/new` (mode "create") and `/tms/shipments/:id/edit` (mode "edit").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog } from '@/features/tms/kit'
import { flattenDivisions } from '@/features/tms/settings/taxonomyDrafts'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { useAuth } from '@/hooks/useAuth'
import { useCarriers } from '@/hooks/useCarriers'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipment } from '@/hooks/useShipment'
import { useStaff } from '@/hooks/useStaff'
import { getTmsSettings } from '@/lib/apiClient'
import type { ShipmentBundle, TmsSettings } from '@/types/tms'
import { SECTION_COMPONENTS } from './defaultSections'
import { FormSection } from './FormSection'
import { SECTION_ORDER, SECTION_TITLE } from './labels'
import { lockedFields, type FormMode, type FormStop, type ShipmentFormValues } from './model'
import type { FormCtx, FormIssue, SectionKey } from './sectionProps'
import type { FormApi } from './sectionRegistry'
import { useFormActions } from './useFormActions'
import { useShipmentForm, type RunKind } from './useShipmentForm'
import { blockingIssues, issueSummary, issuesForSection } from './validation'
import './form.css'

const NEW_PATH = '/tms/shipments'

type SliceKey = 'ship' | 'customer' | 'roles' | 'more' | 'rates' | 'carrier' | 'checkCall'

function sectionsStorageKey(email: string): string {
  return `tms:ship-form:sections:${email}`
}

function readOpen(email: string): Partial<Record<SectionKey, boolean>> {
  try {
    const raw = localStorage.getItem(sectionsStorageKey(email))
    return raw ? (JSON.parse(raw) as Partial<Record<SectionKey, boolean>>) : {}
  } catch {
    return {}
  }
}

export function ShipmentFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { id } = useParams()
  const location = useLocation()
  const { bundle, loading, error } = useShipment(mode === 'edit' ? (id ?? null) : null)
  const prefill = (location.state as { customerId?: string } | null)?.customerId
  if (mode === 'edit' && (loading || !bundle)) {
    return (
      <div className="tms-dense-page tms-ship-form" data-testid="ship-form-loading">
        <div className="tms-ship-form-scroll">
          {error
            ? <TmsAlert tone="red">{error}</TmsAlert>
            : <p className="tms-muted">Loading shipment…</p>}
        </div>
      </div>
    )
  }
  return <ShipmentFormInner key={`${mode}:${id ?? 'new'}`} initialBundle={mode === 'edit' ? bundle : null} prefillCustomerId={prefill} />
}

function ShipmentFormInner({ initialBundle, prefillCustomerId }: { initialBundle: ShipmentBundle | null; prefillCustomerId?: string }) {
  const navigate = useNavigate()
  const { user, isAdmin } = useAuth()
  const email = user?.email ?? ''
  const directory = useDirectory()
  const { carriers } = useCarriers()
  const { staff } = useStaff(email)
  const { divisions } = useOwnershipDivisions()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => {
    let live = true
    getTmsSettings().then((s) => { if (live) setSettings(s) }).catch(() => { if (live) setSettings(null) })
    return () => { live = false }
  }, [])

  const [open, setOpen] = useState<Partial<Record<SectionKey, boolean>>>(() => readOpen(email))
  const [confirmCancel, setConfirmCancel] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const pipelineCtx = useMemo(() => ({
    locations: directory.locations,
    settings,
    actorName: email,
    refreshDirectory: () => { void directory.refresh() },
    onNotice: (msg: string) => { toast.message(msg) },
  }), [directory, settings, email])

  const isOpen = (key: SectionKey) => open[key] !== false
  const setSectionOpen = useCallback((keys: SectionKey[], value: boolean) => {
    setOpen((prev) => {
      const next = { ...prev }
      for (const k of keys) next[k] = value
      try { localStorage.setItem(sectionsStorageKey(email), JSON.stringify(next)) } catch { /* storage full or blocked */ }
      return next
    })
  }, [email])
  const toggle = useCallback((key: SectionKey) => {
    setOpen((prev) => {
      const next = { ...prev, [key]: prev[key] === false }
      try { localStorage.setItem(sectionsStorageKey(email), JSON.stringify(next)) } catch { /* storage full or blocked */ }
      return next
    })
  }, [email])

  const form = useShipmentForm({
    email,
    initialBundle,
    customers: directory.customers,
    staff,
    settings,
    pipelineCtx,
    prefillCustomerId,
    onCreated: (b) => {
      toast.success(`Shipment ${b.shipment.number} created`)
      navigate(`/tms/shipments/${b.shipment.id}/edit`, { replace: true })
    },
    onSubmitted: (b) => {
      toast.success(`Shipment ${b.shipment.number} submitted`)
      navigate(`/tms/shipments/${b.shipment.id}`)
    },
    onBlocked: (issues) => setSectionOpen([...new Set(issues.map((i) => i.section))], true),
  })
  const { values, update, getValues, bundle, mode, busy: pipelineBusy } = form

  const { actions, dialogs, busy } = useFormActions({
    values, update, bundle, setBundle: form.setBundle, busy: pipelineBusy, settings, isAdmin, brokerName: 'BCAT Logistics',
  })

  const formApi = useMemo<FormApi>(() => ({
    getValues,
    update,
    focusField: (fieldKey, section) => {
      if (section) setSectionOpen([section], true)
      setTimeout(() => {
        const el = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid]') ?? [])].find((n) => n.dataset.testid === fieldKey)
        el?.scrollIntoView?.({ block: 'center' })
        el?.focus()
      }, 0)
    },
  }), [getValues, update, setSectionOpen])

  const status = bundle?.shipment.status ?? 'NEW'
  const locked = useMemo(() => lockedFields(bundle), [bundle])
  const ctx = useMemo<FormCtx>(() => ({
    mode,
    bundle,
    shipmentStatus: status,
    locked,
    directory: { customers: directory.customers, locations: directory.locations, carriers, staff },
    settings,
    customer: form.customer,
    divisions: flattenDivisions(divisions ?? []),
    busy,
    actions,
    issues: form.issues,
  }), [mode, bundle, status, locked, directory.customers, directory.locations, carriers, staff, settings, form.customer, divisions, busy, actions, form.issues])

  // Slice onChange handlers are created once; they read the latest values through `update`.
  const slice = useMemo(() => {
    const make = <K extends SliceKey>(key: K) => (patch: Partial<ShipmentFormValues[K]> | ((p: ShipmentFormValues[K]) => ShipmentFormValues[K])) =>
      update((p) => ({
        ...p,
        [key]: typeof patch === 'function' ? patch(p[key]) : { ...p[key], ...patch },
      }))
    return {
      ship: make('ship'), customer: make('customer'), roles: make('roles'), more: make('more'),
      rates: make('rates'), carrier: make('carrier'), checkCall: make('checkCall'),
      stops: (patch: Partial<FormStop[]> | ((p: FormStop[]) => FormStop[])) =>
        update((p) => ({ ...p, stops: typeof patch === 'function' ? patch(p.stops) : (patch as FormStop[]) })),
      docs: (patch: Partial<ShipmentFormValues['docs']> | ((p: ShipmentFormValues['docs']) => ShipmentFormValues['docs'])) =>
        update((p) => ({ ...p, docs: typeof patch === 'function' ? patch(p.docs) : { ...p.docs, ...patch } })),
      mode: (m: FormMode) => update((p) => ({ ...p, mode: m })),
      stop: (which: 'first' | 'last') => (patch: Partial<FormStop> | ((p: FormStop) => FormStop)) =>
        update((p) => {
          const i = which === 'first' ? 0 : p.stops.length - 1
          const cur = p.stops[i]
          if (!cur) return p
          const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }
          return { ...p, stops: p.stops.map((s, j) => (j === i ? next : s)) }
        }),
    }
  }, [update])
  const onPickup = useMemo(() => slice.stop('first'), [slice])
  const onConsignee = useMemo(() => slice.stop('last'), [slice])

  const C = SECTION_COMPONENTS
  const lastIndex = Math.max(0, values.stops.length - 1)
  const sectionBody: Record<SectionKey, React.ReactNode> = {
    shipping: <C.shipping value={values.ship} onChange={slice.ship} ctx={ctx} form={formApi} mode={values.mode} onModeChange={slice.mode} />,
    customer: <C.customer value={values.customer} onChange={slice.customer} ctx={ctx} form={formApi} />,
    pickup: <C.pickup kind="pickup" index={0} stop={values.stops[0]} onChange={onPickup} ctx={ctx} form={formApi} />,
    consignee: <C.consignee kind="consignee" index={lastIndex} stop={values.stops[lastIndex]} onChange={onConsignee} ctx={ctx} form={formApi} />,
    history: <C.history stops={values.stops} equipmentType={values.ship.equipmentType} ctx={ctx} form={formApi} />,
    roles: <C.roles value={values.roles} onChange={slice.roles} ctx={ctx} form={formApi} />,
    more: <C.more value={values.more} onChange={slice.more} ctx={ctx} form={formApi} values={values} />,
    rates: <C.rates value={values.rates} onChange={slice.rates} ctx={ctx} form={formApi} values={values} ship={values.ship} />,
    carrier: <C.carrier value={values.carrier} onChange={slice.carrier} ctx={ctx} form={formApi} values={values} />,
    picks: <C.picks value={values.stops} onChange={slice.stops} ctx={ctx} form={formApi} />,
    documents: <C.documents value={values.docs} onChange={slice.docs} ctx={ctx} form={formApi} values={values} />,
    checkCalls: <C.checkCalls value={values.checkCall} onChange={slice.checkCall} ctx={ctx} form={formApi} values={values} />,
  }

  // ── header actions ──
  const isDraftStatus = status === 'NEW' || status === 'DRAFT'
  const voided = locked.voided
  const primaryKind: RunKind = mode === 'create' ? 'create' : 'save'
  const { run } = form
  const blocking = blockingIssues(form.issues)
  const attempted = form.attempt !== null && blocking.length > 0

  const cancel = () => {
    if (form.dirty) { setConfirmCancel(true); return }
    leave()
  }
  const leave = () => navigate(bundle ? `${NEW_PATH}/${bundle.shipment.id}` : NEW_PATH)

  useEffect(() => {
    if (!form.dirty || !bundle) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [form.dirty, bundle])

  const runRef = useRef({ run, primaryKind, voided, isDraftStatus })
  useEffect(() => { runRef.current = { run, primaryKind, voided, isDraftStatus } })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = runRef.current
      if (r.voided) return
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void r.run(r.primaryKind); return }
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.key === 's' || e.key === 'S') && (r.primaryKind === 'create' || r.isDraftStatus)) { e.preventDefault(); void r.run('draft'); return }
      if (e.key === '[' || e.key === ']') {
        const toggles = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-section-toggle]') ?? [])]
        if (toggles.length === 0) return
        const at = toggles.indexOf(document.activeElement as HTMLElement)
        const next = e.key === ']' ? (at + 1) % toggles.length : (at <= 0 ? toggles.length - 1 : at - 1)
        toggles[next].focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const title = bundle ? `Shipment ${bundle.shipment.number} · edit` : 'New truckload shipment'
  const errorsBySection = (key: SectionKey) => blockingIssues(issuesForSection(form.issues, key)).length

  return (
    <div className="tms-dense-page tms-ship-form" ref={rootRef} data-testid="ship-form" data-mode={mode}>
      <div className="tms-dense-bar">
        <span className="tms-dense-title" data-testid="ship-form-title">{title}</span>
        <TmsBadge tone={isDraftStatus ? 'gray' : 'blue'}>{status === 'NEW' ? 'New' : status}</TmsBadge>
        {form.dirty ? <span className="tms-ship-dirty" data-testid="ship-form-dirty" title="Unsaved changes" role="img" aria-label="Unsaved changes" /> : null}
        <span className="tms-dense-spacer" />
        {isDraftStatus ? (
          <TmsButton
            size="sm" data-testid="ship-form-save-draft" disabled={busy || voided} onClick={() => { void run('draft') }}
            title={mode === 'create' ? 'The first server save consumes a permanent shipment number' : undefined}
          >
            Save draft
          </TmsButton>
        ) : null}
        <TmsButton
          size="sm" variant="primary" data-testid={mode === 'create' ? 'ship-form-create' : 'ship-form-save'}
          disabled={busy || voided} onClick={() => { void run(primaryKind) }}
        >
          {mode === 'create' ? 'Create shipment' : 'Save changes'}
        </TmsButton>
        {mode === 'edit' && status === 'DRAFT' ? (
          <TmsButton size="sm" variant="primary" data-testid="ship-form-submit" disabled={busy || voided} onClick={() => { void run('submit') }}>
            Submit order
          </TmsButton>
        ) : null}
        <TmsButton size="sm" variant="ghost" data-testid="ship-form-cancel" onClick={cancel}>Cancel</TmsButton>
      </div>

      <div className="tms-ship-form-scroll">
        {voided ? <TmsAlert tone="red" className="tms-ship-banner">{locked.fields.all}</TmsAlert> : null}

        {mode === 'create' && form.drafts.length > 0 ? (
          <div data-testid="ship-form-drafts">
            {form.drafts.map((d) => (
              <TmsAlert key={d.clientDraftId} tone="blue" className="tms-ship-banner">
                <span>You have an unsaved draft from {new Date(d.savedAt).toLocaleString()} — </span>
                <TmsButton size="sm" variant="ghost" data-testid={`ship-form-draft-resume-${d.clientDraftId}`} onClick={() => form.resumeDraft(d.clientDraftId)}>Resume</TmsButton>
                <TmsButton size="sm" variant="ghost" data-testid={`ship-form-draft-discard-${d.clientDraftId}`} onClick={() => form.discardDraft(d.clientDraftId)}>Discard</TmsButton>
              </TmsAlert>
            ))}
          </div>
        ) : null}

        {form.partial ? (
          <TmsAlert tone="orange" className="tms-ship-banner">
            <div data-testid="ship-form-partial">
              Created {form.partial.number}, but these steps did not finish: {form.partial.failedSteps.join(', ')}. {form.partial.message}
              {' '}
              <TmsButton size="sm" data-testid="ship-form-retry" disabled={busy} onClick={() => { void form.retry() }}>Retry</TmsButton>
            </div>
          </TmsAlert>
        ) : null}

        {attempted ? (
          <TmsAlert tone="red" className="tms-ship-issues">
            <div data-testid="ship-form-issues">
              <span data-testid="ship-form-issues-summary">{issueSummary(form.issues)}</span>
              <ul>
                {blocking.map((i: FormIssue) => (
                  <li key={i.id}>
                    <button type="button" data-testid={`issue-link-${i.id}`} onClick={() => formApi.focusField(i.fieldKey, i.section)}>
                      {i.label}
                    </button>
                    {i.message ? <span> — {i.message}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </TmsAlert>
        ) : null}

        <div className="tms-ship-grid">
          {SECTION_ORDER.map((key) => (
            <FormSection key={key} id={key} title={SECTION_TITLE[key]} open={isOpen(key)} onToggle={toggle} errorCount={errorsBySection(key)}>
              {sectionBody[key]}
            </FormSection>
          ))}
        </div>
      </div>

      {dialogs}
      <TmsDialog
        open={confirmCancel} onOpenChange={setConfirmCancel} title="Discard unsaved changes?"
        footer={(
          <>
            <TmsButton data-testid="ship-form-keep-editing" onClick={() => setConfirmCancel(false)}>Keep editing</TmsButton>
            <TmsButton variant="destructive" data-testid="ship-form-discard" onClick={() => { setConfirmCancel(false); leave() }}>Discard</TmsButton>
          </>
        )}
      >
        <p>Your changes to this shipment have not been saved.</p>
      </TmsDialog>
    </div>
  )
}
