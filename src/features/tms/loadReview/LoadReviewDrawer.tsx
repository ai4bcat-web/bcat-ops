import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'
import { RepPicker } from '@/components/RepPicker'
import { useAuth } from '@/hooks/useAuth'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { TmsBadge, TmsButton, TmsCard, TmsDrawer, TmsSelect } from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { ReleaseGateList } from '@/features/shipments/components/ReleaseGateCard'
import { releaseGateMessages } from '@/features/shipments/components/releaseGateView'
import { toast } from 'sonner'
import { useBillingGrant, LOAD_REVIEW_GRANT_MESSAGE } from '@/features/ar/useBillingGrant'
import { reviewLoad, readyToInvoice, releaseToBilling, setSalesRep, setRevTag, type LoadReviewResult } from '@/lib/apiClient'
import { DOCS_LANDING } from '@/features/shipments/workstations/tracking/legacyRoutes'
import { NO_DELIVERY_TIME_TIP, evaluateLoadReview, pendingApRecordNotes, failingReasons, reviewAgeDays, LOAD_REVIEW_CHECKS, LOAD_REVIEW_CHECK_LABEL } from '@/lib/loadReview'
import { CarrierBillsPanel } from './CarrierBillsPanel'
import { deliveredText, deliveredTimeOf } from './reviewStatus'
import { StatusPill } from '@/features/shipments/StatusPill'
import { LoadReviewDocuments } from './LoadReviewDocuments'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateTime } from '@/lib/date'

export function LoadReviewDrawer({ row, onClose, onRefresh, onMoved, onFailure }: {
  row: ShipmentListRow
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
  const [division, setDivision] = useState(row.revDivision ?? '')
  const [subdivision, setSubdivision] = useState(row.revSubdivision ?? '')
  useEffect(() => {
    let live = true
    reviewLoad({ shipmentId: row.id }).then((answer) => { if (live) setResult(answer) })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [row.id])
  const currentDivision = result?.revDivision ?? row.revDivision
  const verdict = evaluateLoadReview({ row: result ? { ...row, salesRepId: result.salesRepId, revDivision: result.revDivision, pendingDocReviewCount: result.pendingDocReviewCount } : row, gate: result?.releaseGate, extras: result?.extras, revDivisionActive: divisions ? divisions.some((division) => division.code === currentDivision && division.active) : undefined })
  const reasons = failingReasons(verdict)
  const released = result != null && result.arStatus !== 'DOCS_NEEDED'
  const active = (divisions ?? []).filter((d) => d.active)
  const parent = active.find((d) => d.code === division)
  const children = active.filter((d) => d.parentId === parent?.id)

  async function fix(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      await action()
      await onRefresh()
      setResult(await reviewLoad({ shipmentId: row.id }))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
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
      : (row.docsRequired ?? []).map((type) => `${type}: ${row.docsMissing?.includes(type) ? 'missing' : 'on file'}`).join(' · ') || 'No documents required beyond the POD',
  }
  const [now] = useState(() => Date.now())
  // Same delivered-time fallback as the header (shipment stamp, load stamp, last delivery stop time).
  const age = reviewAgeDays({ deliveredAt: deliveredTimeOf(row) }, now)
  const passed = LOAD_REVIEW_CHECKS.filter((key) => verdict.checks[key].ok).length
  return <TmsDrawer open onOpenChange={(open) => { if (!open) onClose() }} title={shipmentLink('overview', row.number)}
    description={`${row.customerName ?? '—'} · ${row.originCity ?? '—'} → ${row.destinationCity ?? '—'} · ${deliveredTimeOf(row) ? `Delivered ${formatDateTime(deliveredTimeOf(row))}` : deliveredText(row) === '—' ? 'Delivered —' : deliveredText(row)}`}
    headerExtra={<><StatusPill row={row} /><TmsBadge tone={verdict.ok ? 'green' : 'orange'}>{released ? 'Already released' : verdict.ok ? result ? 'Ready' : 'Looks ready' : `${reasons.length} to fix`}</TmsBadge><span title={age == null ? NO_DELIVERY_TIME_TIP : undefined}><TmsBadge tone={age != null && age >= 7 ? 'red' : age != null && age >= 3 ? 'orange' : 'gray'}>{age == null ? 'No delivery time' : age + ' d'}</TmsBadge></span></>}
    footer={<div className="lr-footer">
      {!released && !verdict.ok && <div className="lr-footer-blockers" role="note">
        <p className="lr-footer-title">{`Fix ${reasons.length} ${reasons.length === 1 ? 'item' : 'items'} first.`}</p>
        <ul>{reasons.map((reason, index) => <li key={`${reason.code}-${index}`}><XCircle size={14} aria-hidden className="lr-icon-bad" />{reason.message}</li>)}</ul>
      </div>}
      {!canRelease && <p role="note" className="tms-muted text-xs">{LOAD_REVIEW_GRANT_MESSAGE}</p>}
      <div className="lr-footer-actions">
        <TmsButton variant="primary" disabled={busy || !result || !verdict.ok || released || !!error || !canRelease} title={canRelease ? undefined : LOAD_REVIEW_GRANT_MESSAGE} onClick={() => void move()}>Move to billing</TmsButton>
        <span className="lr-footer-spacer" />
        {shipmentLink('overview', 'Open shipment')}
        <TmsButton variant="ghost" disabled={busy || !result} onClick={() => void rereview()}>Re-check</TmsButton>
        <TmsButton variant="ghost" onClick={onClose}>Close</TmsButton>
      </div>
    </div>}>
    {!result && !error && <p role="status">Checking release requirements…</p>}
    {error && <ReleaseGateList messages={releaseGateMessages(error) ?? [error]} />}
    {result && <div className={`lr-summary ${verdict.ok ? 'lr-summary-ok' : 'lr-summary-bad'}`} data-testid="lr-summary">
      <p className="lr-summary-count">{verdict.ok ? <CheckCircle2 size={18} aria-hidden className="lr-icon-ok" /> : <XCircle size={18} aria-hidden className="lr-icon-bad" />}{`${passed} of ${LOAD_REVIEW_CHECKS.length} checks passed`}</p>
      <ul className="lr-summary-chips">{LOAD_REVIEW_CHECKS.map((key) => <li key={key} className={verdict.checks[key].ok ? 'lr-chip-ok' : 'lr-chip-bad'}>
        {verdict.checks[key].ok ? <CheckCircle2 size={13} aria-label="Passed" /> : <XCircle size={13} aria-label="Needs fixing" />}{LOAD_REVIEW_CHECK_LABEL[key]}
      </li>)}</ul>
    </div>}
    {LOAD_REVIEW_CHECKS.map((key) => <TmsCard key={key} className={`lr-check ${verdict.checks[key].ok ? 'lr-check-ok' : 'lr-check-bad'}`}
      title={<span className="lr-check-title">{verdict.checks[key].ok ? <CheckCircle2 size={16} aria-label="Passed" className="lr-icon-ok" /> : <XCircle size={16} aria-label="Needs fixing" className="lr-icon-bad" />}{LOAD_REVIEW_CHECK_LABEL[key]}</span>}
      actions={<TmsBadge tone={verdict.checks[key].ok ? 'green' : 'red'}>{verdict.checks[key].ok ? 'OK' : `${verdict.checks[key].reasons.length} ${verdict.checks[key].reasons.length === 1 ? 'issue' : 'issues'}`}</TmsBadge>}>
      <p className="lr-check-value">{values[key]}</p>
      {verdict.checks[key].reasons.length > 0 && <ul className="lr-reasons">{verdict.checks[key].reasons.map((reason, index) => <li key={`${reason.code}-${index}`}><XCircle size={14} aria-hidden className="lr-icon-bad" />{reason.message}</li>)}</ul>}
      {key === 'charges' && !released && pendingApRecordNotes(row).map((note) => <p key={note} className="tms-muted">{note}</p>)}
      {key === 'salesRep' && !released && <RepPicker value={result?.salesRepId ?? row.salesRepId ?? ''} allowUnknown disabled={busy} placeholder="Pick a sales rep…" onChange={(repId) => void fix(() => setSalesRep({ shipmentId: row.id, repId: repId || null }))} />}
      {key === 'revDivision' && !released && <div className="flex flex-wrap gap-2">
        <TmsSelect aria-label="Revenue division" value={division} disabled={busy} onChange={(event) => { setDivision(event.target.value); setSubdivision('') }}><option value="">Select division</option>{active.filter((d) => !d.parentId).map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}</TmsSelect>
        <TmsSelect aria-label="Subdivision" value={subdivision} disabled={busy || !children.length} onChange={(event) => setSubdivision(event.target.value)}><option value="">Whole division</option>{children.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}</TmsSelect>
        <TmsButton disabled={busy || !division} onClick={() => void fix(() => setRevTag({ shipmentId: row.id, divisionCode: division, subdivisionCode: subdivision || undefined }))}>Set division</TmsButton>
      </div>}
      {verdict.checks[key].reasons.map((reason, index) => reason.action?.kind === 'OPEN_TAB' ? <p key={`${reason.code}-${index}`}>{shipmentLink(reason.action.tab, `Fix in ${reason.action.tab} tab`, true)}</p> : null)}
      {key === 'documents' && <LoadReviewDocuments shipmentId={row.id} readOnly={released} disabled={busy} onChanged={changed} />}
      {key === 'documents' && <p>{canOpen ? <Link to={DOCS_LANDING}>Review uploads</Link> : <span title="Needs the Shipments grant">Review uploads</span>}</p>}
    </TmsCard>)}
    {(row.carrierCount ?? 0) >= 2 && !released && <CarrierBillsPanel shipmentId={row.id} disabled={busy} canOpenAp={hasPageAccess('carrierPay') || hasPageAccess('tms')} onChanged={rereview} />}
    {verdict.warnings.map((warning) => <p key={warning}>{warning}</p>)}
  </TmsDrawer>
}
