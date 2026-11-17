import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'
import { RepPicker } from '@/components/RepPicker'
import { useAuth } from '@/hooks/useAuth'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { TmsBadge, TmsButton, TmsCard, TmsDrawer, TmsSelect } from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { ReleaseGateList } from '@/features/shipments/components/ReleaseGateCard'
import { DetentionPill, DetentionSection } from '@/features/shipments/components/Detention'
import { TonuPill, TonuSection } from '@/features/shipments/components/Tonu'
import { releaseGateMessages } from '@/features/shipments/components/releaseGateView'
import { toast } from 'sonner'
import { useBillingGrant, LOAD_REVIEW_GRANT_MESSAGE } from '@/features/ar/useBillingGrant'
import { reviewLoad, readyToInvoice, releaseToBilling, setSalesRep, setRevTag, type LoadReviewResult } from '@/lib/apiClient'
import { NO_DELIVERY_TIME_TIP, evaluateLoadReview, failingReasons, reviewAgeDays, LOAD_REVIEW_CHECKS, LOAD_REVIEW_CHECK_LABEL } from '@/lib/loadReview'
import { CarrierBillsPanel } from './CarrierBillsPanel'
import { deliveredText, deliveredTimeOf } from './reviewStatus'
import { StatusPill } from '@/features/shipments/StatusPill'
import { LoadReviewDocuments } from './LoadReviewDocuments'
import { LoadReviewCharges } from './LoadReviewCharges'
import { ReviewFixPanel } from './ReviewFixPanel'
import { ReturnToActiveDialog } from './ReturnToActiveDialog'
import { FIELD_ANCHOR, anchorForReason, scrollToFix } from './reviewFix'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateTime } from '@/lib/date'
import { DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { RailSaveContext, runPendingSaves, useRailPending, type PendingSave, type RailSaveRegistry } from './railSave'

/** Sales rep, saved with the rail's Save changes. */
function SalesRepFix({ current, shipmentId, disabled }: { current: string; shipmentId: string; disabled: boolean }) {
  const [rep, setRep] = useState(current)
  const dirty = rep !== current
  const error = useRailPending('salesRep', dirty ? { label: 'Sales rep', order: 50, run: () => setSalesRep({ shipmentId, repId: rep || null }) } : null)
  return <>
    <RepPicker value={rep} allowUnknown disabled={disabled} placeholder="Pick a sales rep…" onChange={(repId) => setRep(repId ?? '')} />
    {dirty && <span className="lr-unsaved" data-testid="lr-unsaved">Unsaved</span>}
    {error && <p role="alert" className="lr-fix-error">{error}</p>}
  </>
}

/** Revenue division and subdivision, saved with the rail's Save changes. */
function DivisionFix({ current, currentSub, shipmentId, disabled, active }: {
  current: string; currentSub: string; shipmentId: string; disabled: boolean
  active: { id: string; code: string; name: string; parentId?: string | null }[]
}) {
  const [division, setDivision] = useState(current)
  const [subdivision, setSubdivision] = useState(currentSub)
  const parent = active.find((d) => d.code === division)
  const children = active.filter((d) => d.parentId === parent?.id)
  const dirty = Boolean(division) && (division !== current || subdivision !== currentSub)
  const error = useRailPending('revDivision', dirty ? { label: 'Revenue division', order: 40, run: () => setRevTag({ shipmentId, divisionCode: division, subdivisionCode: subdivision || undefined }) } : null)
  return <div className="flex flex-wrap gap-2">
    <TmsSelect aria-label="Revenue division" value={division} disabled={disabled} onChange={(event) => { setDivision(event.target.value); setSubdivision('') }}><option value="">Select division</option>{active.filter((d) => !d.parentId).map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}</TmsSelect>
    <TmsSelect aria-label="Subdivision" value={subdivision} disabled={disabled || !children.length} onChange={(event) => setSubdivision(event.target.value)}><option value="">Whole division</option>{children.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}</TmsSelect>
    {dirty && <span className="lr-unsaved" data-testid="lr-unsaved">Unsaved</span>}
    {error && <p role="alert" className="lr-fix-error">{error}</p>}
  </div>
}

export function LoadReviewDrawer({ row, focus, onClose, onRefresh, onMoved, onFailure }: {
  row: ShipmentListRow
  /** A review column (LoadReviewFieldKey) the reviewer clicked: the rail opens scrolled to its editor. */
  focus?: string | null
  onClose: () => void
  onRefresh: () => Promise<void>
  onMoved: () => void
  onFailure: (message: string) => void
}) {
  const { hasPageAccess } = useAuth()
  const canOpen = hasPageAccess('loads') || hasPageAccess('tms')
  const canRelease = useBillingGrant('loadReview')
  const { divisions } = useOwnershipDivisions()
  const [result, setResult] = useState<LoadReviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The rail's one Save: every section with edits registers here (railSave.ts).
  const pending = useRef(new Map<string, PendingSave>())
  const [pendingLabels, setPendingLabels] = useState<string[]>([])
  const [saveErrors, setSaveErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [reloadSignal, setReloadSignal] = useState(0)
  const [confirmClose, setConfirmClose] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  const registerPending = useCallback((key: string, save: PendingSave | null) => {
    if (save) pending.current.set(key, save)
    else pending.current.delete(key)
    setPendingLabels([...pending.current.values()].sort((a, b) => a.order - b.order).map((p) => p.label))
    if (!save) setSaveErrors((errors) => { if (!errors.has(key)) return errors; const next = new Map(errors); next.delete(key); return next })
  }, [])
  const registry = useMemo<RailSaveRegistry>(() => ({ set: registerPending, errorOf: (key) => saveErrors.get(key) ?? null }), [registerPending, saveErrors])
  useEffect(() => {
    let live = true
    reviewLoad({ shipmentId: row.id }).then((answer) => { if (live) setResult(answer) })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [row.id])
  const focused = useRef(false)
  useEffect(() => {
    if (!result || focused.current || !focus) return
    const anchor = FIELD_ANCHOR[focus]
    focused.current = true
    if (anchor) window.setTimeout(() => scrollToFix(anchor), 50)
  }, [result, focus])
  const currentDivision = result?.revDivision ?? row.revDivision
  const verdict = evaluateLoadReview({ row: result ? { ...row, salesRepId: result.salesRepId, revDivision: result.revDivision, pendingDocReviewCount: result.pendingDocReviewCount } : row, gate: result?.releaseGate, extras: result?.extras, revDivisionActive: divisions ? divisions.some((division) => division.code === currentDivision && division.active) : undefined })
  const reasons = failingReasons(verdict)
  const released = result != null && result.arStatus !== 'DOCS_NEEDED'
  const active = (divisions ?? []).filter((d) => d.active)

  // Recording bills only changes this review: re-read it in place. A board refresh here would swap the drawer's row
  // out from under the panel and wipe its per-carrier result list.
  async function rereview() {
    try { setResult(await reviewLoad({ shipmentId: row.id })) } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }
  // A file or bill landed: re-run the review here, then let the board's cached columns catch up.
  async function changed() {
    await rereview()
    void onRefresh()
  }
  // Fixing something in the shipment's own tab (opened in a new browser tab) and coming back re-runs the review.
  useEffect(() => {
    const onFocus = () => { if (!busy) void rereview() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, row.id])
  /** Saves every section with edits, then re-runs the review once. Returns true when everything saved. */
  async function saveAll(): Promise<boolean> {
    if (pending.current.size === 0) return true
    setBusy(true)
    setError(null)
    try {
      const failures = await runPendingSaves(new Map(pending.current))
      setSaveErrors(failures)
      setReloadSignal((n) => n + 1)
      await rereview()
      void onRefresh()
      if (failures.size === 0) toast.success('Saved')
      else toast.error(`${failures.size} ${failures.size === 1 ? 'section' : 'sections'} could not be saved: see the red notes in the rail.`)
      return failures.size === 0
    } finally { setBusy(false) }
  }
  function requestClose() {
    if (pending.current.size > 0) setConfirmClose(true)
    else onClose()
  }
  async function move() {
    if (!result || !verdict.ok || released) return
    setBusy(true)
    setError(null)
    try {
      await readyToInvoice({ orderId: result.orderId, expectedUpdatedAt: result.orderUpdatedAt, review: { source: 'LOAD_REVIEW' } })
      // The order is now with accounting; releasing it invoices it (and queues it for the factor, or leaves it Ready to send).
      try {
        const released = await releaseToBilling({ orderId: result.orderId, clientRequestId: `${result.orderId}:${result.orderUpdatedAt}` })
        if (released.warnings.includes('OVER_CREDIT_LIMIT')) toast.warning('This customer is over their credit limit. The invoice was still released.')
      } catch (err) {
        await onRefresh()
        throw new Error(`Moved to accounting, but not invoiced: ${err instanceof Error ? err.message : String(err)} Fix that, then release it from Invoicing.`, { cause: err })
      }
      await onRefresh()
      onMoved()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      onFailure(message)
    } finally { setBusy(false) }
  }
  function shipmentLink(tab: string, label: string, newTab = false) {
    return canOpen ? <Link to={`/tms/shipments/${row.id}?tab=${tab}`} {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{label}</Link>
      : <span title="Needs the Shipments grant">{label}</span>
  }
  const values = {
    salesRep: row.salesRepName ?? result?.salesRepId ?? row.salesRepId ?? 'Unassigned',
    revDivision: active.find((d) => d.code === (result?.revDivision ?? row.revDivision))?.name ?? result?.revDivision ?? row.revDivision ?? 'Unassigned',
    details: `Bill-to ${row.billToName ?? row.customerName ?? '—'} · PO ${row.refPo ?? '—'} · ${row.stops?.length ?? 0} stops · ${(row.carrierCount ?? 0) >= 2 ? `${row.carrierCount} carriers` : row.carrierName ?? row.driverName ?? 'Unassigned'}`,
    charges: `Customer ${formatCents(row.orderRevenueCents ?? row.revenueCents ?? 0)} · Cost ${formatCents(row.costCents ?? 0)} · Margin ${row.marginBps == null ? '—' : `${(row.marginBps / 100).toFixed(1)}%`}`,
    documents: row.docsMissing == null && !row.docsRequired?.length ? 'Required documents are checked below'
      : (row.docsRequired ?? []).map((type) => `${DOCUMENT_TYPE_LABELS[type as keyof typeof DOCUMENT_TYPE_LABELS] ?? type}: ${row.docsMissing?.includes(type) ? 'missing' : 'on file'}`).join(' · ') || 'No documents required beyond the POD',
  }
  const [now] = useState(() => Date.now())
  // Same delivered-time fallback as the header (shipment stamp, load stamp, last delivery stop time).
  const age = reviewAgeDays({ deliveredAt: deliveredTimeOf(row) }, now)
  const passed = LOAD_REVIEW_CHECKS.filter((key) => verdict.checks[key].ok).length
  const unsaved = pendingLabels.length
  return <RailSaveContext.Provider value={registry}><TmsDrawer open onOpenChange={(open) => { if (!open) requestClose() }} title={shipmentLink('overview', row.number)}
    description={`${row.customerName ?? '—'} · ${row.originCity ?? '—'} → ${row.destinationCity ?? '—'} · ${deliveredTimeOf(row) ? `Delivered ${formatDateTime(deliveredTimeOf(row))}` : deliveredText(row) === '—' ? 'Delivered —' : deliveredText(row)}`}
    headerExtra={<><StatusPill row={row} inReviewQueue /><DetentionPill flag={row.detentionFlag} /><TonuPill flag={row.tonuFlag} /><TmsBadge tone={verdict.ok ? 'green' : 'orange'}>{released ? 'Already released' : verdict.ok ? result ? 'Ready' : 'Looks ready' : `${reasons.length} to fix`}</TmsBadge><span title={age == null ? NO_DELIVERY_TIME_TIP : undefined}><TmsBadge tone={age != null && age >= 7 ? 'red' : age != null && age >= 3 ? 'orange' : 'gray'}>{age == null ? 'No delivery time' : age + ' d'}</TmsBadge></span></>}
    footer={<div className="lr-footer">
      {!released && !verdict.ok && <div className="lr-footer-blockers" role="note">
        <p className="lr-footer-title">{`Fix ${reasons.length} ${reasons.length === 1 ? 'item' : 'items'} first.`}</p>
        <ul>{reasons.map((reason, index) => <li key={`${reason.code}-${index}`}><XCircle size={14} aria-hidden className="lr-icon-bad" />{reason.message}</li>)}</ul>
      </div>}
      {!canRelease && <p role="note" className="tms-muted text-xs">{LOAD_REVIEW_GRANT_MESSAGE}</p>}
      {confirmClose && unsaved > 0 && <div className="lr-footer-blockers" role="alertdialog" aria-label="Unsaved changes" data-testid="lr-confirm-close">
        <p className="lr-footer-title">{`Unsaved changes: ${pendingLabels.join(', ')}.`}</p>
        <div className="lr-footer-actions">
          <TmsButton variant="primary" disabled={busy} onClick={() => void saveAll().then((ok) => { if (ok) { setConfirmClose(false); onClose() } })}>Save</TmsButton>
          <TmsButton variant="ghost" disabled={busy} onClick={() => { setConfirmClose(false); onClose() }}>Discard</TmsButton>
          <TmsButton variant="ghost" disabled={busy} onClick={() => setConfirmClose(false)}>Cancel</TmsButton>
        </div>
      </div>}
      <div className="lr-footer-actions">
        <TmsButton variant="primary" disabled={busy || unsaved === 0 || released} data-testid="lr-save-all" title={unsaved ? pendingLabels.join(', ') : 'Nothing to save'} onClick={() => void saveAll()}>{unsaved ? `Save changes (${unsaved})` : 'Save changes'}</TmsButton>
        <TmsButton variant={unsaved ? 'secondary' : 'primary'} disabled={busy || !result || !verdict.ok || released || !!error || !canRelease || unsaved > 0} title={unsaved ? 'Save your changes first' : canRelease ? undefined : LOAD_REVIEW_GRANT_MESSAGE} onClick={() => void move()}>Move to billing</TmsButton>
        <span className="lr-footer-spacer" />
        {shipmentLink('overview', 'Open shipment')}
        <TmsButton variant="ghost" disabled={busy || released} data-testid="lr-return-active" title="Send this load back to the Active shipments board" onClick={() => setReturnOpen(true)}>Move back to Active</TmsButton>
        <TmsButton variant="ghost" disabled={busy || !result} onClick={() => void rereview()}>Re-check</TmsButton>
        <TmsButton variant="ghost" onClick={requestClose}>Close</TmsButton>
      </div>
    </div>}>
    <ReturnToActiveDialog open={returnOpen} onOpenChange={setReturnOpen} ids={[row.id]} label={row.number} onDone={() => { void onRefresh(); onClose() }} />
    <DetentionSection shipment={row} onChanged={() => { void onRefresh() }} />
    <TonuSection shipment={row} onChanged={() => { void onRefresh() }} />
    {!result && !error && <p role="status">Checking release requirements…</p>}
    {error && <ReleaseGateList messages={releaseGateMessages(error) ?? [error]} />}
    {result && <div className={`lr-summary ${verdict.ok ? 'lr-summary-ok' : 'lr-summary-bad'}`} data-testid="lr-summary">
      <p className="lr-summary-count">{verdict.ok ? <CheckCircle2 size={18} aria-hidden className="lr-icon-ok" /> : <XCircle size={18} aria-hidden className="lr-icon-bad" />}{`${passed} of ${LOAD_REVIEW_CHECKS.length} checks passed`}</p>
      <ul className="lr-summary-chips">{LOAD_REVIEW_CHECKS.map((key) => <li key={key} className={verdict.checks[key].ok ? 'lr-chip-ok' : 'lr-chip-bad'}>
        {verdict.checks[key].ok ? <CheckCircle2 size={13} aria-label="Passed" /> : <XCircle size={13} aria-label="Needs fixing" />}{LOAD_REVIEW_CHECK_LABEL[key]}
      </li>)}</ul>
    </div>}
    {result && <ReviewFixPanel shipmentId={row.id} readOnly={released} busy={busy} reloadSignal={reloadSignal} failing={new Set(reasons.map((r) => r.code))} onSaved={changed} />}
    {LOAD_REVIEW_CHECKS.map((key) => <TmsCard key={key} className={`lr-check ${verdict.checks[key].ok ? 'lr-check-ok' : 'lr-check-bad'}`}
      title={<span id={`lr-check-${key}`} className="lr-check-title">{verdict.checks[key].ok ? <CheckCircle2 size={16} aria-label="Passed" className="lr-icon-ok" /> : <XCircle size={16} aria-label="Needs fixing" className="lr-icon-bad" />}{LOAD_REVIEW_CHECK_LABEL[key]}</span>}
      actions={<TmsBadge tone={verdict.checks[key].ok ? 'green' : 'red'}>{verdict.checks[key].ok ? 'OK' : `${verdict.checks[key].reasons.length} ${verdict.checks[key].reasons.length === 1 ? 'issue' : 'issues'}`}</TmsBadge>}>
      {key !== 'charges' && <p className="lr-check-value">{values[key]}</p>}
      {verdict.checks[key].reasons.length > 0 && <ul className="lr-reasons">{verdict.checks[key].reasons.map((reason, index) => <li key={`${reason.code}-${index}`}><XCircle size={14} aria-hidden className="lr-icon-bad" />{reason.message}</li>)}</ul>}
      {key === 'charges' && <LoadReviewCharges shipmentId={row.id} readOnly={released} disabled={busy} onChanged={changed} />}
      {key === 'salesRep' && !released && <SalesRepFix key={result?.salesRepId ?? row.salesRepId ?? ''} current={result?.salesRepId ?? row.salesRepId ?? ''} shipmentId={row.id} disabled={busy} />}
      {key === 'revDivision' && !released && <DivisionFix key={`${result?.revDivision ?? row.revDivision ?? ''}:${row.revSubdivision ?? ''}`} current={result?.revDivision ?? row.revDivision ?? ''} currentSub={row.revSubdivision ?? ''} shipmentId={row.id} disabled={busy} active={active} />}
      {verdict.checks[key].reasons.map((reason, index) => {
        if (reason.action?.kind !== 'OPEN_TAB') return null
        const anchor = anchorForReason(reason.code, reason.action.tab)
        // Every fix is made in this rail; the reason jumps to its editor instead of sending the reviewer to another tab.
        return anchor === key ? null : <p key={`${reason.code}-${index}`}><TmsButton size="sm" variant="ghost" onClick={() => scrollToFix(anchor)}>{`Fix: ${reason.message}`}</TmsButton></p>
      })}
      {key === 'documents' && <LoadReviewDocuments shipmentId={row.id} readOnly={released} disabled={busy} onChanged={changed} />}
    </TmsCard>)}
    {(row.carrierCount ?? 0) >= 2 && !released && <CarrierBillsPanel shipmentId={row.id} disabled={busy} canOpenAp={hasPageAccess('carrierPay') || hasPageAccess('tms')} onChanged={rereview} />}
    {verdict.warnings.map((warning) => <p key={warning}>{warning}</p>)}
  </TmsDrawer></RailSaveContext.Provider>
}
