import { ReviewBatchEdit } from './ReviewBatchEdit'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, X } from 'lucide-react'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsListPage, TmsSelect, TmsStatRow, type ColumnDef } from '@/features/tms/kit'
import { useAuth } from '@/hooks/useAuth'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { isDemoShipment, matchesQuery } from '@/features/shipments/shipmentViews'
import { batchShipmentTask, listAuditLogsFor, pushReadyToLoadReview, releaseToBilling } from '@/lib/apiClient'
import { useBillingGrant, BILLING_GRANT_MESSAGE } from '@/features/ar/useBillingGrant'
import { failingReasons, LOAD_REVIEW_CHECKS, LOAD_REVIEW_CHECK_LABEL, releasedWithin, reviewAgeDays, type LoadReviewVerdict } from '@/lib/loadReview'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateTime } from '@/lib/date'
import { useLoadReviewQueue } from './useLoadReviewQueue'
import { LoadReviewDrawer } from './LoadReviewDrawer'
import { MAX_REVIEW_BATCH, batchCapMessage } from '@/lib/reviewRequirements'
import './loadReview.css'

type ReviewEntry = { row: ShipmentListRow; verdict?: LoadReviewVerdict }
export function LoadReviewPage() {
  const [params, setParams] = useSearchParams()
  const { shipments, queue, target, loading, partial, error, refresh } = useLoadReviewQueue(params.get('tab') === 'released', params.get('shipment'))
  const { hasPageAccess, user } = useAuth()
  const email = user?.email ?? ''
  const canOpen = hasPageAccess('loads') || hasPageAccess('tms')
  const canRelease = useBillingGrant()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [capMessage, setCapMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempts, setAttempts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<string | null>(null)
  const [audit, setAudit] = useState<Record<string, { user: string; at: string }>>({})
  const [auditError, setAuditError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const needs = queue.filter((entry) => !entry.verdict.ok)
  const ready = queue.filter((entry) => entry.verdict.ok)
  const released = shipments.filter((row) => releasedWithin(row, now))
  const tab = params.get('tab') ?? (needs.length ? 'fixes' : 'ready')
  const source: ReviewEntry[] = tab === 'released' ? released.map((row) => ({ row })) : tab === 'ready' ? ready : tab === 'all' ? queue : needs
  const filtered = source.filter(({ row }) => matchesQuery(row, params.get('q') ?? '')
    && (!params.get('division') || row.revDivision === params.get('division'))
    && (!params.get('rep') || row.salesRepId === params.get('rep'))
    && (!params.get('customer') || row.customerId === params.get('customer'))
    && (params.get('demo') !== '1' || isDemoShipment(row)))
  const pageNumber = Math.max(0, Number(params.get('page')) || 0)
  const page = filtered.slice(pageNumber * 50, pageNumber * 50 + 50)
  const eligible = filtered.filter((entry) => entry.verdict?.ok)
  const chosen = eligible.filter(({ row }) => selected.has(row.id)).slice(0, MAX_REVIEW_BATCH).map(({ row }) => row.id)
  // Any ticked row can be batch-edited (a row that still needs fixes is exactly the one you want to fix); only a clean one can be released.
  const editChosen = filtered.filter(({ row }) => selected.has(row.id)).slice(0, MAX_REVIEW_BATCH).map(({ row }) => row.id)
  const openRow = shipments.find((row) => row.id === params.get('shipment')) ?? target
  function update(values: Record<string, string | null>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key) }
      return next
    }, { replace: true })
  }
  const auditIdsKey = tab === 'released'
    ? JSON.stringify(page.flatMap(({ row }) => [{ entityType: 'SHIPMENT', entityId: row.id }, ...(row.orderIds ?? []).map((entityId) => ({ entityType: 'ORDER', entityId }))]))
    : '[]'
  useEffect(() => {
    const entities: Array<{ entityType: string; entityId: string }> = JSON.parse(auditIdsKey)
    if (!entities.length) return
    let live = true
    // Indexed per (entityType, entityId); order ids cover older releases that logged on the order.
    const reads = []
    for (let offset = 0; offset < entities.length; offset += 50) reads.push(listAuditLogsFor(entities.slice(offset, offset + 50)))
    Promise.all(reads).then((pages) => {
      const logs = pages.flat()
      if (!live) return
      const entries: Record<string, { user: string; at: string }> = {}
      const sorted = logs.filter((log) => ['LOAD_REVIEW_RELEASED', 'READY_TO_INVOICE'].includes(String(log.action)))
        .sort((a, b) => (String(a.action) === 'LOAD_REVIEW_RELEASED' ? 0 : 1) - (String(b.action) === 'LOAD_REVIEW_RELEASED' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt))
      for (const log of sorted) if (!entries[log.entityId]) entries[log.entityId] = { user: log.user, at: log.createdAt }
      setAudit(entries)
      setAuditError(null)
    }).catch((err: unknown) => { if (live) setAuditError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [auditIdsKey])
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!openRow || !['[', ']'].includes(event.key) || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]'))) return
      const index = filtered.findIndex(({ row }) => row.id === openRow.id)
      const next = filtered[index + (event.key === ']' ? 1 : -1)]
      if (next) { event.preventDefault(); update({ shipment: next.row.id }) }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  async function releaseBatch() {
    setBusy(true)
    try {
      const result = await batchShipmentTask({ task: 'RELEASE_TO_BILLING', shipmentIds: chosen, params: { review: { source: 'LOAD_REVIEW' } } })
      // Accounting accepted the shipment; releasing each of its orders invoices it (factor queue or Ready to send).
      for (const entry of result.results) {
        if (!entry.ok) continue
        const orderIds = shipments.find((row) => row.id === entry.shipmentId)?.orderIds ?? []
        try {
          for (const orderId of orderIds) {
            const released = await releaseToBilling({ orderId, clientRequestId: `batch:${orderId}` })
            if (released.warnings.includes('OVER_CREDIT_LIMIT')) entry.message = 'Over credit limit (released anyway)'
          }
        } catch (err) {
          entry.ok = false
          entry.message = `Moved to accounting, not invoiced: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      setAttempts((old) => ({ ...old, ...Object.fromEntries(result.results.map((entry) => [entry.shipmentId, entry.ok ? 'Moved to billing' : entry.message ?? 'Release refused'])) }))
      setSelected(new Set())
      setCapMessage(null)
      setNotice(result.results.map((entry) => `${entry.number ?? entry.shipmentId}: ${entry.ok ? 'Moved to billing' : entry.message}`).join('\n'))
      setConfirm(false)
      await refresh()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false); setConfirm(false) }
  }
  const columns: ColumnDef<ReviewEntry>[] = [
    { key: 'select', header: 'Select', render: ({ row, verdict }) => tab === 'released' ? null : <input type="checkbox" aria-label={`Select ${row.number}`} title={verdict && !verdict.ok ? failingReasons(verdict)[0]?.message : undefined} checked={selected.has(row.id)} onClick={(event) => event.stopPropagation()} onChange={(event) => {
      if (event.target.checked && !selected.has(row.id) && selected.size >= MAX_REVIEW_BATCH) { setCapMessage(batchCapMessage()); return }
      setCapMessage(null)
      setSelected((old) => { const next = new Set(old); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next })
    }} /> },
    { key: 'shipment', header: 'Shipment', render: ({ row }) => <><TmsButton variant="ghost" onClick={() => update({ shipment: row.id })}>{row.number}</TmsButton>{attempts[row.id] && <p>Last attempt: {attempts[row.id]}</p>}</> },
    { key: 'customer', header: 'Customer', render: ({ row }) => row.customerName ?? '—' },
    { key: 'lane', header: 'Lane', render: ({ row }) => `${row.originCity ?? '—'} → ${row.destinationCity ?? '—'}` },
    { key: 'delivered', header: 'Delivered', render: ({ row }) => formatDateTime(row.deliveredAt) },
    { key: 'age', header: 'In review', render: ({ row }) => { const age = reviewAgeDays(row, now); return <TmsBadge tone={age != null && age >= 7 ? 'red' : age != null && age >= 3 ? 'orange' : 'gray'}>{age == null ? 'POD before delivery' : `${age} d`}</TmsBadge> } },
    { key: 'rep', header: 'Sales rep', render: ({ row }) => row.salesRepName ?? row.salesRepId ?? '—' },
    { key: 'division', header: 'Division', render: ({ row }) => row.revDivision ?? '—' },
    // One column per check, each a clear pass (check mark) or fail (cross) with its reason on hover, plus a result column up front:
    // "All passed" or how many need fixing.
    { key: 'checks', header: 'Checks (preliminary)', render: ({ verdict }) => {
      if (!verdict) return null
      const failed = LOAD_REVIEW_CHECKS.filter((key) => !verdict.checks[key].ok)
      return <TmsBadge tone={failed.length === 0 ? 'green' : 'red'} title="Cached checks are preliminary. The server re-checks before release.">{failed.length === 0 ? `All ${LOAD_REVIEW_CHECKS.length} passed` : `${failed.length} to fix`}</TmsBadge>
    } },
    ...LOAD_REVIEW_CHECKS.map((key): ColumnDef<ReviewEntry> => ({
      key: `check-${key}`,
      header: LOAD_REVIEW_CHECK_LABEL[key],
      render: ({ verdict }) => {
        if (!verdict) return null
        const ok = verdict.checks[key].ok
        const reasons = verdict.checks[key].reasons.map((reason) => reason.message).join('; ')
        return (
          <span className={`aa-check ${ok ? 'aa-check-pass' : 'aa-check-fail'}`} role="img" aria-label={`${LOAD_REVIEW_CHECK_LABEL[key]}: ${ok ? 'Passed' : reasons || 'Needs fixing'}`} title={ok ? 'Passed' : reasons || 'Needs fixing'}>
            {ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
            <span>{ok ? 'Pass' : 'Fix'}</span>
          </span>
        )
      },
    })),
    { key: 'revenue', header: 'Revenue', render: ({ row }) => formatCents(row.orderRevenueCents ?? row.revenueCents ?? 0) },
    { key: 'status', header: tab === 'released' ? 'Released by / at' : 'Status', render: ({ row, verdict }) => { if (tab === 'released') { const entry = audit[row.id] ?? (row.orderIds ?? []).map((id) => audit[id]).find(Boolean); return <>{entry?.user ?? 'Audit unavailable'} · {formatDateTime(entry?.at ?? row.readyToInvoiceAt)} {canOpen && <Link to={`/tms/shipments/${row.id}?tab=invoicing`}>Open invoicing</Link>}</> } return <TmsBadge tone={verdict?.ok ? 'green' : 'orange'}>{verdict?.ok ? 'Looks ready' : `${verdict ? failingReasons(verdict).length : 0} to fix`}</TmsBadge> } },
  ]
  const field = filter === 'division' ? 'revDivision' : filter === 'rep' ? 'salesRepId' : 'customerId'
  const options = [...new Set(shipments.map((row) => row[field]).filter((value): value is string => !!value))].sort()
  return <div className="aa-load-review">
    {error && <TmsAlert tone="red">{error}</TmsAlert>}{auditError && <TmsAlert tone="red">{auditError}</TmsAlert>}
    {capMessage && <TmsAlert tone="orange" title="Selection limit">{capMessage}</TmsAlert>}
    {notice && <div role="status" className="aa-review-results" style={{ whiteSpace: 'pre-line' }}>{notice}</div>}
    <TmsListPage title="Review · Load review" rows={page} columns={columns} rowKey={({ row }) => row.id} onRowClick={({ row }) => update({ shipment: row.id })}
      onRefresh={() => void refresh()} search={{ value: params.get('q') ?? '', onChange: (q) => update({ q, page: null }), placeholder: 'Shipment, customer or reference' }}
      quickTabs={{ active: tab, onSelect: (key) => { update({ tab: key, page: null }); setSelected(new Set()); setCapMessage(null) }, tabs: [{ key: 'fixes', label: 'Needs fixes', count: needs.length }, { key: 'ready', label: 'Looks ready', count: ready.length }, { key: 'all', label: 'All in review', count: queue.length }, { key: 'released', label: 'Released (14 d)', count: released.length }] }}
      filterChips={[
        ...['division', 'rep', 'customer'].map((key) => ({ key, label: key === 'division' ? 'Revenue division' : key === 'rep' ? 'Sales rep' : 'Customer', value: params.get(key), onClick: () => setFilter(key) })),
        { key: 'demo', label: 'Demo', value: params.get('demo') === '1' ? 'only' : null, onClick: () => update({ demo: params.get('demo') === '1' ? null : '1', page: null }) },
      ]}
      actions={tab !== 'released' && <><TmsButton onClick={() => { setSelected(new Set(eligible.slice(0, MAX_REVIEW_BATCH).map(({ row }) => row.id))); setCapMessage(eligible.length > MAX_REVIEW_BATCH ? batchCapMessage() : null) }}>Select all looks ready (up to {MAX_REVIEW_BATCH})</TmsButton><TmsButton disabled={busy} data-testid="review-pull-ready" title="Delivered shipments with their references, sales rep, order details and documents move in by themselves; this sweeps any that are waiting" onClick={() => { setBusy(true); pushReadyToLoadReview().then((r) => { setNotice(`${r.pushed} delivered shipment${r.pushed === 1 ? '' : 's'} moved into Load Review (${r.checked} checked)`); void refresh() }).catch((e: unknown) => setNotice(e instanceof Error ? e.message : 'Could not sweep')).finally(() => setBusy(false)) }}>Move ready loads in</TmsButton></>}
      banner={<TmsStatRow columns={5} items={[{ label: 'In review', value: String(queue.length) }, { label: 'Looks ready', value: String(ready.length) }, { label: 'Needs fixes', value: String(needs.length) }, { label: 'Oldest', value: `${Math.max(0, ...queue.map(({ row }) => reviewAgeDays(row, now) ?? 0))} d` }, { label: 'Value in review', value: formatCents(queue.reduce((sum, { row }) => sum + (row.orderRevenueCents ?? row.revenueCents ?? 0), 0)) }]} />}
      page={{ from: filtered.length ? pageNumber * 50 + 1 : 0, to: pageNumber * 50 + page.length, total: filtered.length, pageSize: 50 }}
      footerExtra={<><TmsButton disabled={!pageNumber} onClick={() => update({ page: String(pageNumber - 1) })}>Previous</TmsButton><TmsButton disabled={(pageNumber + 1) * 50 >= filtered.length} onClick={() => update({ page: String(pageNumber + 1) })}>Next</TmsButton></>}
      emptyText={loading || partial ? 'Loading review queue…' : queue.length ? 'Nothing here.' : 'Nothing is waiting for review.'} />
    {tab !== 'released' && <ReviewBatchEdit ids={editChosen} email={email} onDone={() => { setSelected(new Set()); void refresh() }} />}
    {!!chosen.length && <div className="aa-review-actions"><TmsButton variant="primary" disabled={!canRelease} title={canRelease ? undefined : BILLING_GRANT_MESSAGE} onClick={() => setConfirm(true)}>Move {chosen.length} to billing</TmsButton>{!canRelease && <p role="note" className="tms-muted">{BILLING_GRANT_MESSAGE}</p>}</div>}
    <TmsDialog open={confirm} onOpenChange={setConfirm} title={`Move ${chosen.length} to billing`} description={`These ${chosen.length} shipments go to accounting. The server re-checks each one.`} footer={<TmsButton disabled={busy || !chosen.length} variant="primary" onClick={() => void releaseBatch()}>Confirm move to billing</TmsButton>} />
    <TmsDialog open={!!filter} onOpenChange={(open) => { if (!open) setFilter(null) }} title="Filter review queue"><TmsSelect aria-label="Filter value" value={filter ? params.get(filter) ?? '' : ''} onChange={(event) => { if (filter) update({ [filter]: event.target.value, page: null }); setFilter(null) }}><option value="">All</option>{options.map((value) => <option key={value} value={value}>{value}</option>)}</TmsSelect></TmsDialog>
    {openRow && <LoadReviewDrawer key={openRow.id} row={openRow} onClose={() => update({ shipment: null })} onRefresh={refresh} onFailure={(message) => setAttempts((old) => ({ ...old, [openRow.id]: message }))} onMoved={() => { setNotice(`${openRow.number}: Moved to billing`); const index = filtered.findIndex(({ row }) => row.id === openRow.id); update({ shipment: filtered[index + 1]?.row.id ?? null }) }} />}
  </div>
}
