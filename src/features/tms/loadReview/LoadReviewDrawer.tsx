import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { RepPicker } from '@/components/RepPicker'
import { useAuth } from '@/hooks/useAuth'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { TmsBadge, TmsButton, TmsCard, TmsDrawer, TmsSelect } from '@/features/tms/kit'
import { useOwnershipDivisions } from '@/features/tms/useOwnershipDivisions'
import { ReleaseGateList } from '@/features/shipments/components/ReleaseGateCard'
import { releaseGateMessages } from '@/features/shipments/components/releaseGateView'
import { reviewLoad, readyToInvoice, setSalesRep, setRevTag, type LoadReviewResult } from '@/lib/apiClient'
import { DOCS_LANDING } from '@/features/shipments/workstations/tracking/legacyRoutes'
import { evaluateLoadReview, failingReasons, reviewAgeDays, LOAD_REVIEW_CHECKS, LOAD_REVIEW_CHECK_LABEL } from '@/lib/loadReview'
import { CarrierBillsPanel } from './CarrierBillsPanel'
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
  async function move() {
    if (!result || !verdict.ok || released) return
    setBusy(true)
    setError(null)
    try {
      await readyToInvoice({ orderId: result.orderId, expectedUpdatedAt: result.orderUpdatedAt, review: { source: 'LOAD_REVIEW' } })
      await onRefresh()
      onMoved()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      onFailure(message)
    } finally { setBusy(false) }
  }
  function shipmentLink(tab: string, label: string) {
    return canOpen ? <Link to={`/tms/shipments/${row.id}?tab=${tab}`}>{label}</Link>
      : <span title="Needs the Shipments grant">{label}</span>
  }
  const values = {
    salesRep: row.salesRepName ?? result?.salesRepId ?? row.salesRepId ?? 'Unassigned',
    revDivision: active.find((d) => d.code === (result?.revDivision ?? row.revDivision))?.name ?? result?.revDivision ?? row.revDivision ?? 'Unassigned',
    details: `Bill-to ${row.billToName ?? row.customerName ?? '—'} · PO ${row.refPo ?? '—'} · ${row.stops?.length ?? 0} stops · ${(row.carrierCount ?? 0) >= 2 ? `${row.carrierCount} carriers` : row.carrierName ?? row.driverName ?? 'Unassigned'}`,
    charges: `Customer ${formatCents(row.orderRevenueCents ?? row.revenueCents ?? 0)} · Cost ${formatCents(row.costCents ?? 0)} · Margin ${row.marginBps == null ? '—' : `${(row.marginBps / 100).toFixed(1)}%`}`,
    documents: (row.docsRequired ?? []).map((type) => `${type}: ${row.docsMissing?.includes(type) ? 'missing' : row.docsMissing == null ? 'unchecked' : 'present'}`).join(' · ') || 'Documents not checked yet',
  }
  const [now] = useState(() => Date.now())
  const age = reviewAgeDays(row, now)
  return <TmsDrawer open onOpenChange={(open) => { if (!open) onClose() }} title={shipmentLink('overview', row.number)}
    description={`${row.customerName ?? '—'} · ${row.originCity ?? '—'} → ${row.destinationCity ?? '—'} · Delivered ${formatDateTime(row.deliveredAt)}`}
    headerExtra={<><TmsBadge tone={verdict.ok ? 'green' : 'orange'}>{released ? 'Already released' : verdict.ok ? result ? 'Ready' : 'Looks ready' : `${reasons.length} to fix`}</TmsBadge><TmsBadge tone={age != null && age >= 7 ? 'red' : age != null && age >= 3 ? 'orange' : 'gray'}>{age == null ? 'POD before delivery' : age + ' d'}</TmsBadge></>}
    footer={<><TmsButton variant="primary" disabled={busy || !result || !verdict.ok || released || !!error} onClick={() => void move()}>Move to billing</TmsButton>{shipmentLink('overview', 'Open shipment')}<TmsButton variant="ghost" onClick={onClose}>Close</TmsButton></>}>
    {!result && !error && <p role="status">Checking release requirements…</p>}
    {error && <ReleaseGateList messages={releaseGateMessages(error) ?? [error]} />}
    {LOAD_REVIEW_CHECKS.map((key) => <TmsCard key={key} title={LOAD_REVIEW_CHECK_LABEL[key]}>
      <p className="flex items-center gap-2">{verdict.checks[key].ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}{values[key]}</p>
      <ReleaseGateList messages={verdict.checks[key].reasons.map((reason) => reason.message)} />
      {key === 'salesRep' && !released && <RepPicker value={result?.salesRepId ?? row.salesRepId ?? ''} allowUnknown disabled={busy} placeholder="Pick a sales rep…" onChange={(repId) => void fix(() => setSalesRep({ shipmentId: row.id, repId: repId || null }))} />}
      {key === 'revDivision' && !released && <div className="flex flex-wrap gap-2">
        <TmsSelect aria-label="Revenue division" value={division} disabled={busy} onChange={(event) => { setDivision(event.target.value); setSubdivision('') }}><option value="">Select division</option>{active.filter((d) => !d.parentId).map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}</TmsSelect>
        <TmsSelect aria-label="Subdivision" value={subdivision} disabled={busy || !children.length} onChange={(event) => setSubdivision(event.target.value)}><option value="">Whole division</option>{children.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}</TmsSelect>
        <TmsButton disabled={busy || !division} onClick={() => void fix(() => setRevTag({ shipmentId: row.id, divisionCode: division, subdivisionCode: subdivision || undefined }))}>Set division</TmsButton>
      </div>}
      {verdict.checks[key].reasons.map((reason, index) => reason.action?.kind === 'OPEN_TAB' ? <p key={`${reason.code}-${index}`}>{shipmentLink(reason.action.tab, `Open ${reason.action.tab}`)}</p> : null)}
      {key === 'documents' && <p>{canOpen ? <Link to={DOCS_LANDING}>Review uploads</Link> : <span title="Needs the Shipments grant">Review uploads</span>}</p>}
    </TmsCard>)}
    {(row.carrierCount ?? 0) >= 2 && !released && <CarrierBillsPanel shipmentId={row.id} disabled={busy} canOpenAp={hasPageAccess('carrierPay') || hasPageAccess('tms')} onChanged={rereview} />}
    {verdict.warnings.map((warning) => <p key={warning}>{warning}</p>)}
  </TmsDrawer>
}
