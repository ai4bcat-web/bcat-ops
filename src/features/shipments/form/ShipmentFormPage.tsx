/**
 * Create / edit shipment (Step AR): header bar, nine numbered cards in build order, the "More" tab
 * strip (Instructions, References, Items, Notes), and the sticky summary rail. Route element for `/tms/shipments/new` (mode "create") and
 * `/tms/shipments/:id/edit` (mode "edit"). Fields, mapping, pipelines and validation are Step AH's.
 */
import { useShipmentLock } from './useShipmentLock'
import { useShipmentTabs } from '../tabs/shipmentTabsContext'
import { useRequiredEmptyMarks } from './useRequiredEmptyMarks'
import { findCustomerMatches } from '@/lib/tmsDirectory'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsAlert, TmsButton, TmsDialog } from '@/features/tms/kit'
import { flattenDivisions } from '@/features/tms/settings/taxonomyDrafts'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { useAuth } from '@/hooks/useAuth'
import { useCarriers } from '@/hooks/useCarriers'
import { useDirectory } from '@/hooks/useDirectory'
import { useShipment } from '@/hooks/useShipment'
import { useStaff } from '@/hooks/useStaff'
import { useOwnFleetRoster } from '@/hooks/useOwnFleetRoster'
import { getShipmentBundle, getTmsSettings, linkIntakeShipment, listLocations, pushToLoadReview } from '@/lib/apiClient'
import { useIntakeLoad } from '../intake/useIntakeLoads'
import { AttachmentPreview } from '../intake/SourceEmailCard'
import type { LocationRecord, ShipmentBundle, TmsSettings } from '@/types/tms'
import { CARD_ORDER, CARD_TITLE, type CardKey, type CardProps, type MoreTabKey } from './cards/cardRegistry'
import { CARD_COMPONENTS, MORE_TAB_COMPONENTS, RAIL_RATE_HISTORY, RAIL_ROLES } from './defaultSections'
import { ActionBar } from './ActionBar'
import { DuplicateDialog } from './DuplicateDialog'
import { FormHeader } from './FormHeader'
import { FormSection } from './FormSection'
import { FromEmailContext } from './fromEmail'
import { intakePrefill } from './intakePrefill'
import { LABEL } from './labels'
import { lockedFields } from './model'
import { MoreTabs } from './MoreTabs'
import { cardOfSection, proPreview, railSummary, requiredProgress, requiredRows } from './railModel'
import type { FormCtx, FormIssue } from './sectionProps'
import type { FormApi } from './sectionRegistry'
import { SummaryRail } from './SummaryRail'
import { useFormActions } from './useFormActions'
import { useShipmentForm, type RunKind } from './useShipmentForm'
import { blockingIssues, issueSummary } from './validation'
import './form.css'

const NEW_PATH = '/tms/shipments'

/** The More tab a blocking issue lives in. */
function moreTabOfIssue(i: FormIssue): MoreTabKey {
  return i.fieldKey === LABEL.more.references.testId ? 'references' : 'instructions'
}

export function ShipmentFormPage({ mode, shipmentId }: { mode: 'create' | 'edit'; shipmentId?: string }) {
  const params = useParams()
  // A tab's form is drawn by the tab host, not by the route, so it is told which shipment it is for.
  const id = shipmentId ?? params.id
  const location = useLocation()
  const { bundle, loading, error } = useShipment(mode === 'edit' ? (id ?? null) : null)
  const [search] = useSearchParams()
  const prefill = (location.state as { customerId?: string } | null)?.customerId
  // Intake → Create shipment: the intake load's id arrives as router state, or `?intake=` after a refresh.
  const intakeId = mode === 'create' ? ((location.state as { intakeId?: string } | null)?.intakeId ?? search.get('intake') ?? undefined) : undefined
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
  return <ShipmentFormInner key={`${mode}:${id ?? 'new'}`} initialBundle={mode === 'edit' ? bundle : null} prefillCustomerId={prefill} intakeId={intakeId} />
}

function ShipmentFormInner({ initialBundle, prefillCustomerId, intakeId }: { initialBundle: ShipmentBundle | null; prefillCustomerId?: string; intakeId?: string }) {
  const navigate = useNavigate()
  const intake = useIntakeLoad(intakeId)
  // The e-mail the load came from, for the side-by-side PDF: the one this create page was opened from, or (on an open draft built from
  // intake) the one the shipment is tied to.
  const tiedIntake = useIntakeLoad(intakeId ? undefined : initialBundle?.shipment.intakeLoadId ?? undefined)
  const sourceRow = intake.row ?? tiedIntake.row
  const sourceFiles = (sourceRow?.attachments ?? []).filter((a) => /^(application\/pdf|image\/)/.test(a.contentType))
  const [showSource, setShowSource] = useState(true)
  const [fromEmail, setFromEmail] = useState<ReadonlySet<string>>(() => new Set())
  const seededFor = useRef<string | null>(null)
  // True while Submit for Review runs the order submit on a draft, so that submit does not redirect away from the form.
  const sendingForReview = useRef(false)
  const { user, isAdmin, isOwner, hasPageAccess } = useAuth()
  // Same door as the directory's create action: owner, ADMIN, or the Shipments / Locations / Loads page grants.
  const canCreateLocation = Boolean(isAdmin || isOwner || hasPageAccess('tms') || hasPageAccess('loads') || hasPageAccess('locations'))
  const email = user?.email ?? ''
  const directory = useDirectory({ locations: false })
  // The locations table is 3,000+ rows: read it once, the first time a stop is searched or saved.
  const [locations, setLocations] = useState<LocationRecord[]>([])
  const locationsRead = useRef<Promise<LocationRecord[]> | null>(null)
  const loadLocations = useCallback((): Promise<LocationRecord[]> => {
    locationsRead.current ??= listLocations().then((rows) => { setLocations(rows); return rows })
    return locationsRead.current
  }, [])
  const addLocation = useCallback((loc: LocationRecord) => { setLocations((prev) => (prev.some((l) => l.id === loc.id) ? prev : [...prev, loc])) }, [])
  const ensureLocations = useCallback(() => { void loadLocations().catch(() => { locationsRead.current = null }) }, [loadLocations])
  const { carriers } = useCarriers()
  const { staff } = useStaff(email)
  const ownFleetRoster = useOwnFleetRoster()
  const { divisions } = useOwnershipDivisions()
  const [settings, setSettings] = useState<TmsSettings | null>(null)
  useEffect(() => {
    let live = true
    getTmsSettings().then((s) => { if (live) setSettings(s) }).catch(() => { if (live) setSettings(null) })
    return () => { live = false }
  }, [])

  const [confirmCancel, setConfirmCancel] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [moreTab, setMoreTab] = useState<MoreTabKey>('instructions')
  // The Bill To panel under the header strip: collapsed until asked for (or until a field inside it is focused).
  const [panelOpen, setPanelOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const pipelineCtx = useMemo(() => ({
    ownFleetRoster,
    locations,
    loadLocations,
    settings,
    actorName: email,
    refreshDirectory: () => { locationsRead.current = null; void directory.refresh() },
    onNotice: (msg: string) => { toast.message(msg) },
  }), [directory, locations, loadLocations, settings, email, ownFleetRoster])

  // Scroll to and focus the control whose `data-testid` is `fieldKey`, opening its More tab first.
  const focusField = useCallback((fieldKey: string) => {
    const find = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid]') ?? [])].find((n) => n.dataset.testid === fieldKey)
    const tab = find()?.closest<HTMLElement>('[data-more-tab]')?.dataset.moreTab
    if (tab) setMoreTab(tab as MoreTabKey)
    if (find()?.closest('[data-header-panel]')) setPanelOpen(true)
    setTimeout(() => {
      const el = find()
      // A group (the Customer type-ahead) is not focusable itself: land on the control inside it.
      const target = el && !el.matches('input, select, textarea, button, a[href], [tabindex]') ? (el.querySelector<HTMLElement>('input, select, textarea, button') ?? el) : el
      target?.scrollIntoView?.({ block: 'center' })
      target?.focus()
    }, 0)
  }, [])

  /** Tie the intake row this shipment was pre-filled from to it (moves the row out of Intake). Best-effort: the shipment exists either way; the server call is idempotent. */
  const linkIntake = (b: ShipmentBundle) => {
    const from = intakeId ?? b.shipment.intakeLoadId ?? undefined
    if (!from) return
    linkIntakeShipment({ intakeId: from, shipmentId: b.shipment.id })
      .then(() => toast.success('Intake load marked as moved'))
      .catch((err: unknown) => toast.error(`Saved, but the intake load was not linked: ${err instanceof Error ? err.message : 'unknown error'}`))
  }
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
      linkIntake(b)
      navigate(`/tms/shipments/${b.shipment.id}/edit`, { replace: true })
    },
    // A step after the create failed: the shipment exists, so the intake row it came from must still leave Intake.
    onCreatedPartly: (b) => linkIntake(b),
    onSubmitted: (b) => {
      // Submitting a NEW shipment straight from the intake pre-fill is a create too: without this the intake row stayed in Intake.
      linkIntake(b)
      // Submit for Review opened the order and goes on to push it: stay on the form and let that toast speak.
      if (sendingForReview.current) return
      toast.success(`Shipment ${b.shipment.number} submitted`)
      navigate(`/tms/shipments/${b.shipment.id}`)
    },
    onBlocked: (issues) => { if (issues[0]) focusField(issues[0].fieldKey) },
  })
  const { values, update, getValues, bundle, mode, busy: pipelineBusy } = form
  const { heldBy, release, takeOver } = useShipmentLock(bundle?.shipment.id)
  const tabs = useShipmentTabs()
  const tabId = bundle?.shipment.id
  const tabsDirty = tabs?.setDirty
  const tabsMeta = tabs?.setMeta
  // The tab strip's label and unsaved dot come from this form.
  useEffect(() => {
    if (tabId) tabsMeta?.(tabId, { number: bundle?.shipment.number ?? null, customer: bundle?.shipment.customerName ?? null })
  }, [tabId, tabsMeta, bundle?.shipment.number, bundle?.shipment.customerName])
  useEffect(() => { if (tabId) tabsDirty?.(tabId, form.dirty) }, [tabId, tabsDirty, form.dirty])
  const [confirmTakeOver, setConfirmTakeOver] = useState(false)
  useRequiredEmptyMarks(values)

  // Pre-fill once, when the intake row and the customer directory have both arrived.
  const { seedValues } = form
  useEffect(() => {
    const row = intake.row
    if (!intakeId || !row || directory.loading || seededFor.current === intakeId) return
    seededFor.current = intakeId
    // The e-mail's customer is matched by exact name when the intake review did not pick one, so a built shipment is
    // never left on a typed name with no customer record (no bill-to, no sales rep, nothing to submit).
    const typedName = typeof row.fields.customerName === 'string' ? row.fields.customerName : ''
    const picked = row.fields.customerId
      ? directory.customers.find((c) => c.id === row.fields.customerId) ?? null
      : findCustomerMatches(typedName, directory.customers).find((m) => m.score === 1)?.record ?? null
    const pre = intakePrefill(row, picked)
    seedValues(pre.values, true)
    setFromEmail(new Set(pre.fromEmail))
  }, [intakeId, intake.row, directory.loading, directory.customers, seedValues])

  // The Tracking mode chip on the board links here: land on the Carrier & Tracking card's dispatcher field, once the shipment has loaded.
  const [innerSearch] = useSearchParams()
  const focusTracking = innerSearch.get('focus') === 'tracking'
  const trackingFocused = useRef(false)
  useEffect(() => {
    if (!focusTracking || trackingFocused.current || mode !== 'edit' || !bundle) return
    trackingFocused.current = true
    focusField(LABEL.carrier.dispatcher.testId)
  }, [focusTracking, mode, bundle, focusField])

  const { actions, dialogs, busy } = useFormActions({
    values, update, bundle, setBundle: form.setBundle, busy: pipelineBusy, settings, carriers, isAdmin, brokerName: 'BCAT Logistics',
  })

  const formApi = useMemo<FormApi>(() => ({
    getValues,
    update,
    focusField,
  }), [getValues, update, focusField])

  const status = bundle?.shipment.status ?? 'NEW'
  const shipmentId = bundle?.shipment.id
  const { setBundle } = form
  const { addCustomer: createDirectoryCustomer } = directory
  const addCustomer = useMemo(() => (canCreateLocation ? createDirectoryCustomer : undefined), [canCreateLocation, createDirectoryCustomer])
  const refreshBundle = useCallback(async () => {
    if (shipmentId) setBundle(await getShipmentBundle(shipmentId))
  }, [shipmentId, setBundle])
  const locked = useMemo(() => lockedFields(bundle), [bundle])
  const ctx = useMemo<FormCtx>(() => ({
    mode,
    bundle,
    shipmentStatus: status,
    locked,
    directory: { customers: directory.customers, locations, ensureLocations, carriers, staff },
    settings,
    customer: form.customer,
    divisions: flattenDivisions(divisions ?? []),
    busy,
    dirty: form.dirty,
    actions,
    refreshBundle,
    canCreateLocation,
    addCustomer,
    addLocation,
    issues: form.issues,
  }), [mode, bundle, status, locked, directory.customers, locations, ensureLocations, carriers, staff, settings, form.customer, divisions, busy, form.dirty, actions, refreshBundle, canCreateLocation, addCustomer, addLocation, form.issues])

  const common = useMemo<CardProps>(() => ({
    values, update, ctx, form: formApi, issues: form.issues, mode, locked,
  }), [values, update, ctx, formApi, form.issues, mode, locked])

  // ── header / rail model ──
  const isDraftStatus = status === 'NEW' || status === 'DRAFT'
  const voided = locked.voided
  const { run } = form
  const blocking = blockingIssues(form.issues)
  const attempted = form.attempt !== null && blocking.length > 0
  const rows = useMemo(() => requiredRows(values, mode, { customer: form.customer, settings }), [values, mode, form.customer, settings])
  const progress = useMemo(() => requiredProgress(rows), [rows])
  const summary = useMemo(() => railSummary(values, form.customer, settings), [values, form.customer, settings])

  const errorsByCard = useMemo(() => {
    const out: Partial<Record<CardKey, number>> = {}
    for (const i of blockingIssues(form.issues)) {
      const c = cardOfSection(i.section)
      if (c !== 'more' && c !== 'rail' && c !== 'header') out[c] = (out[c] ?? 0) + 1
    }
    return out
  }, [form.issues])
  const errorsByTab = useMemo(() => {
    const out: Partial<Record<MoreTabKey, number>> = {}
    for (const i of blockingIssues(form.issues)) {
      if (cardOfSection(i.section) !== 'more') continue
      const t = moreTabOfIssue(i)
      out[t] = (out[t] ?? 0) + 1
    }
    return out
  }, [form.issues])

  const togglePanel = useCallback(() => setPanelOpen((o) => !o), [])
  // Leaving on purpose (Discard) lets go of the edit lock; a plain Save does not, so the shipment stays under Currently viewing.
  const closeTab = tabs?.close
  const leave = useCallback(() => { void release(); if (bundle) closeTab?.(bundle.shipment.id); navigate(bundle ? `${NEW_PATH}/${bundle.shipment.id}` : NEW_PATH) }, [navigate, bundle, release, closeTab])
  const cancel = useCallback(() => {
    if (form.dirty) { setConfirmCancel(true); return }
    leave()
  }, [form.dirty, leave])
  const onRun = useCallback((kind: RunKind) => { void run(kind) }, [run])
  // Submit for Review: the board's Push to Load Review (same action, same gates: the server decides) after a save so the gate reads what is on screen.
  // A draft first goes through the order submit (submit validation, credit check, Draft to Open), so the button is the one way a draft becomes an order.
  const orderOf = bundle?.orders?.[0]
  const submitReviewBlocked: string | null = !bundle ? null
    : voided ? 'A voided shipment cannot go to Load Review'
      : status === 'CANCELED' ? 'A canceled shipment cannot go to Load Review'
        : bundle.shipment.legacyImported === true ? 'Imported history is not reviewed'
          : orderOf && orderOf.arStatus !== 'DOCS_NEEDED' ? `Already released (${String(orderOf.arStatus)})`
            : bundle.shipment.loadReviewPushedAt ? 'Already in Load Review'
              : null
  const onSubmitForReview = useCallback(async () => {
    if (!bundle) return
    if (isDraftStatus) {
      // The submit's own redirect to the detail page would pull the user off the form before the push.
      sendingForReview.current = true
      let opened: boolean
      try { opened = await run('submit') } finally { sendingForReview.current = false }
      if (!opened) return
    } else if (form.dirty) {
      if (!await run('save')) return
    }
    try {
      const { results } = await pushToLoadReview([bundle.shipment.id])
      const row = results[0]
      if (row?.ok) {
        toast.success(row.message ?? `Shipment ${bundle.shipment.number ?? ''} sent to Load Review`.trim(), {
          action: { label: 'Open Load review', onClick: () => navigate('/tms/load-review') },
        })
        await refreshBundle()
      } else {
        const reasons = row?.reasons?.length ? row.reasons : [row?.message ?? 'The push was refused']
        toast.error(isDraftStatus ? 'Order submitted, but not sent to Load Review' : 'Not sent to Load Review', { description: reasons.join(' · '), duration: 10000 })
        if (isDraftStatus) await refreshBundle()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The push failed')
    }
  }, [bundle, form.dirty, isDraftStatus, run, refreshBundle, navigate])
  // Save, then let go of the lock right away and go back to the list. A save that fails or is blocked stays on the form with its lock.
  const onSaveExit = useCallback(async () => {
    const saved = await run(isDraftStatus ? 'draft' : 'save')
    if (!saved) return
    await release()
    if (bundle) closeTab?.(bundle.shipment.id)
    navigate(NEW_PATH)
  }, [run, isDraftStatus, release, navigate, bundle, closeTab])

  useEffect(() => {
    if (!form.dirty || !bundle) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [form.dirty, bundle])

  // ⌘/Ctrl+Enter = Create (Save in edit mode); ⌘/Ctrl+S = Save draft (Save in a non-draft edit).
  const runRef = useRef({ run, mode, voided, isDraftStatus })
  useEffect(() => { runRef.current = { run, mode, voided, isDraftStatus } })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = runRef.current
      if (r.voided || !(e.metaKey || e.ctrlKey) || e.altKey) return
      if (e.key === 'Enter') { e.preventDefault(); void r.run(r.mode === 'create' ? 'create' : 'save'); return }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        void r.run(r.mode === 'create' || r.isDraftStatus ? 'draft' : 'save')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const title = bundle ? `Edit PRO ${bundle.shipment.number}` : 'New shipment'
  const pro = bundle?.shipment.number ?? proPreview(settings)

  return (
    <div className="tms-dense-page tms-ship-form" ref={rootRef} data-testid="ship-form" data-mode={mode}>
      <FormHeader
        title={title} dirty={form.dirty} pro={pro} mode={mode}
        common={common} panelOpen={panelOpen} onPanelToggle={togglePanel}
      />

      <div className="tms-ship-form-scroll" data-locked={heldBy ? 'true' : undefined}>
        {voided ? <TmsAlert tone="red" className="tms-ship-banner">{locked.fields.all}</TmsAlert> : null}

        {heldBy ? (
          <TmsAlert tone="orange" className="tms-ship-banner">
            <span data-testid="ship-form-locked">
              {heldBy.by} is editing this shipment{heldBy.until ? ` (locked until ${new Date(heldBy.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}. Open it again once they save and exit.
            </span>
            {' '}
            {confirmTakeOver ? (
              <>
                <TmsButton size="sm" variant="primary" data-testid="ship-form-take-over-confirm"
                  onClick={() => { void takeOver().then((ok) => { setConfirmTakeOver(false); if (ok) { toast.success('You now have this shipment'); void refreshBundle() } else toast.error('Could not take it over') }) }}>
                  Yes, take it over
                </TmsButton>
                <TmsButton size="sm" variant="ghost" onClick={() => setConfirmTakeOver(false)}>Cancel</TmsButton>
              </>
            ) : (
              <TmsButton size="sm" data-testid="ship-form-take-over" title="Use when they have left it open and walked away: anything they have not saved is lost" onClick={() => setConfirmTakeOver(true)}>
                Take over
              </TmsButton>
            )}
          </TmsAlert>
        ) : null}

        {mode === 'create' && form.drafts.length > 0 ? (
          <div data-testid="ship-form-drafts">
            {form.drafts.map((d) => (
              <div key={d.clientDraftId} className="tms-ship-draft" role="status">
                <span>Unsaved draft from {new Date(d.savedAt).toLocaleString()}</span>
                <TmsButton size="sm" variant="ghost" data-testid={`ship-form-draft-resume-${d.clientDraftId}`} onClick={() => form.resumeDraft(d.clientDraftId)}>Resume</TmsButton>
                <TmsButton size="sm" variant="ghost" data-testid={`ship-form-draft-discard-${d.clientDraftId}`} onClick={() => form.discardDraft(d.clientDraftId)}>Discard</TmsButton>
              </div>
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
                    <button type="button" data-testid={`issue-link-${i.id}`} onClick={() => focusField(i.fieldKey)}>
                      {i.label}
                    </button>
                    {i.message ? <span> — {i.message}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          </TmsAlert>
        ) : null}

        {sourceFiles.length > 0 && !showSource ? (
          <div className="tms-ship-banner">
            <TmsButton size="sm" data-testid="ship-form-source-show" onClick={() => setShowSource(true)}>Show the source PDF next to the form</TmsButton>
          </div>
        ) : null}
        {intakeId && intake.error ? <TmsAlert tone="orange" className="tms-ship-banner">Could not load the e-mail to pre-fill from: {intake.error}</TmsAlert> : null}
        {fromEmail.size > 0 ? (
          <TmsAlert tone="blue" className="tms-ship-banner"><span data-testid="ship-form-intake-banner">Pre-filled from the e-mail / rate confirmation ({fromEmail.size} fields). Fields marked “from e-mail” need a look before you create.</span></TmsAlert>
        ) : null}

        <FromEmailContext.Provider value={fromEmail}>
          <div className="tms-ship-layout" data-source={sourceFiles.length > 0 && showSource ? 'open' : undefined}>
            {sourceFiles.length > 0 && showSource ? (
              <aside className="tms-ship-source" data-testid="ship-form-source" aria-label="Source e-mail">
                <div className="tms-ship-source-head">
                  <strong>Source e-mail</strong>
                  <TmsButton size="sm" variant="ghost" data-testid="ship-form-source-hide" onClick={() => setShowSource(false)}>Hide</TmsButton>
                </div>
                <AttachmentPreview attachments={sourceRow!.attachments} />
              </aside>
            ) : null}
            <div className="tms-ship-main">
              {CARD_ORDER.map((key, i) => {
                const Card = CARD_COMPONENTS[key]
                return (
                  <Fragment key={key}>
                    <FormSection id={key} number={i + 1} title={CARD_TITLE[key]} errorCount={errorsByCard[key] ?? 0}>
                      <Card {...common} />
                    </FormSection>
                    {key === 'carrier' ? (
                      <MoreTabs common={common} components={MORE_TAB_COMPONENTS} active={moreTab} onActive={setMoreTab} errors={errorsByTab} />
                    ) : null}
                  </Fragment>
                )
              })}
            </div>
            <SummaryRail
              common={common} summary={summary} rows={rows} attempted={attempted}
              Roles={RAIL_ROLES} RateHistory={RAIL_RATE_HISTORY} intakeId={intakeId} intake={intake.row}
            />
          </div>
        </FromEmailContext.Provider>
      </div>

      <ActionBar
        createMode={mode === 'create'} status={status} dirty={form.dirty} savedAt={bundle?.shipment.updatedAt ?? form.savedAt}
        done={progress.done} total={progress.total} ready={progress.ready} busy={busy} voided={voided} onRun={onRun} onSaveExit={() => { void onSaveExit() }} onDiscard={cancel}
        onSubmitForReview={mode === 'edit' ? () => { void onSubmitForReview() } : undefined}
        submitReviewBlocked={submitReviewBlocked}
        onDuplicate={mode === 'edit' && bundle ? () => setDuplicating(true) : undefined}
      />
      {duplicating && bundle ? (
        <DuplicateDialog
          shipmentId={bundle.shipment.id} number={bundle.shipment.number ?? bundle.shipment.id} onClose={() => setDuplicating(false)}
          onDone={(ids) => { setDuplicating(false); void release(); navigate(`/tms/shipments/${ids[0]}/edit`) }}
        />
      ) : null}

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
