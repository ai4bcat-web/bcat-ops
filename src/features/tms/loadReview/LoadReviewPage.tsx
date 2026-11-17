import { ReviewBatchEdit } from './ReviewBatchEdit'
import { PodPreviewButton } from './PodPreviewButton'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, ClipboardCheck, Download, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { exportRecords, reviewExportRow } from '@/lib/opsExports'
import { TmsAlert, TmsBadge, TmsButton, TmsDialog, TmsInput, TmsTabStrip, type ColumnDef } from '@/features/tms/kit'
import { DenseGrid } from '@/features/tms/grid/DenseGrid'
import { ClearFiltersButton, ColumnsButton, DenseKpiStrip, DensityToggle } from '@/features/tms/grid/DenseControls'
import { activeFilterCount, filterRows, nextSort, reorderKeys, sortDenseRows, type DenseColumn, type DenseColumnFilter, type DenseFilters } from '@/features/tms/grid/denseGridModel'
import { useDenseGridPrefs } from '@/features/tms/grid/useDenseGridPrefs'
import { useAuth } from '@/hooks/useAuth'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { boardStatusOf, matchesQuery } from '@/features/shipments/shipmentViews'
import { boardReqsListText, boardReqsOfRow, boardReqsText } from '@/features/shipments/boardReqs'
import { useBoardReqSources } from '@/features/shipments/useBoardReqSources'
import { FACTOR_INFO_OPTIONS, sentence } from '@/features/shipments/shipmentGridColumns'
import { batchShipmentTask, listAuditLogsFor, pushReadyToLoadReview, releaseToBilling } from '@/lib/apiClient'
import { useBillingGrant, LOAD_REVIEW_GRANT_MESSAGE } from '@/features/ar/useBillingGrant'
import { NO_DELIVERY_TIME_TIP, failingReasons, LOAD_REVIEW_CHECKS, LOAD_REVIEW_CHECK_LABEL, LOAD_REVIEW_FIELDS, LOAD_REVIEW_FIELD_LABEL, releasedWithin, reviewAgeDays, type LoadReviewVerdict } from '@/lib/loadReview'
import { FIX_LINE_LIMIT, fitFixItems, fixLinesOf } from './fixChips'
import { customerRateCents, profitOf, reviewFieldCell, reviewFieldText, reviewReadyText, whatToFixItems, whatToFixText } from './reviewFields'
import { formatCents } from '@/lib/invoiceBuild'
import { formatDateTime } from '@/lib/date'
import { useLoadReviewQueue } from './useLoadReviewQueue'
import { deliveredText, deliveredTimeOf, reviewStatusText } from './reviewStatus'
import { StatusPill } from '@/features/shipments/StatusPill'
import { LoadReviewDrawer } from './LoadReviewDrawer'
import { MAX_REVIEW_BATCH } from '@/lib/reviewRequirements'
import './loadReview.css'
import { DetentionPill } from '@/features/shipments/components/Detention'
import { TonuPill } from '@/features/shipments/components/Tonu'

type ReviewEntry = { row: ShipmentListRow; verdict?: LoadReviewVerdict }
const PAGE_STEP = 50
/** On the All tab a load that passes every check reads green (Ryne 2026-11-15: "highlight the rows in green that are ready to go"). */
const reviewRowTone = (entry: ReviewEntry): string => (entry.verdict?.ok ? 'ready' : '')
/**
 * Every review tab opens on one column per checked field: the value with its own pass mark or NEED, then Ready
 * (Ryne 2026-11-15: "have the checkmarks sit in the same column as the check they are reviewing"). All four tabs share
 * this one layout (Ryne 2026-11-16: "make sure all columns across the load review tabs are all the same"); the customer
 * reads as three columns: name, invoice method, AP email. Released has no verdict, so its cells show values without marks.
 */
const REVIEW_TAB_COLUMNS = [
  'shipment', 'field-customer', 'field-invoiceMethod', 'field-apEmail', 'loadStatus', 'age',
  ...LOAD_REVIEW_FIELDS.filter((key) => key !== 'customer' && key !== 'invoiceMethod' && key !== 'apEmail').map((key) => `field-${key}`),
  'ready', 'whatToFix',
]
/** What to fix wraps inside a fixed-width column; the rows grow to the longest list on the page so nothing is cut off. */
const WHAT_TO_FIX_PX = 420
function whatToFixLines(entries: readonly ReviewEntry[]): number {
  let most = 1
  for (const { verdict } of entries) {
    if (!verdict) continue
    most = Math.max(most, fixLinesOf(whatToFixItems(verdict)))
  }
  return most
}

const fieldSort = (key: string) => (e: ReviewEntry): string | number => {
  if (key === 'customerRate') return customerRateCents(e.row) ?? -Infinity
  if (key === 'carrierRate') return e.row.costCents ?? -Infinity
  if (key === 'profit') return profitOf(e.row)?.cents ?? -Infinity
  return reviewFieldText(e.row, key as never)
}
export function LoadReviewPage() {
  const [params, setParams] = useSearchParams()
  useBoardReqSources()
  const { shipments, queue, target, loading, partial, error, refresh } = useLoadReviewQueue(params.get('tab') === 'released', params.get('shipment'))
  const { hasPageAccess, user } = useAuth()
  const email = user?.email ?? ''
  const canOpen = hasPageAccess('loads') || hasPageAccess('tms')
  const canRelease = useBillingGrant('loadReview')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempts, setAttempts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [dense, setDense] = useState<DenseFilters>({})
  const [pageSize, setPageSize] = useState(PAGE_STEP)
  const [audit, setAudit] = useState<Record<string, { user: string; at: string }>>({})
  const [auditError, setAuditError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())
  const needs = queue.filter((entry) => !entry.verdict.ok)
  const ready = queue.filter((entry) => entry.verdict.ok)
  const released = shipments.filter((row) => releasedWithin(row, now))
  // All in review is the landing tab (Ryne 2026-11-16); a tab in the link still wins.
  const tab = params.get('tab') ?? 'all'
  const source: ReviewEntry[] = tab === 'released' ? released.map((row) => ({ row })) : tab === 'ready' ? ready : tab === 'all' ? queue : needs
  const opt = (v: string | null | undefined, label?: string | null) => (v ? [{ value: v, label: label ?? v }] : [])
  // One dense column per table column: `text` drives auto-fit width and sorting, the header filters narrow division / rep / customer.
  const denseCols = useMemo<Array<DenseColumn<ReviewEntry>>>(() => {
    const failedOf = (e: ReviewEntry) => (e.verdict ? LOAD_REVIEW_CHECKS.filter((key) => !e.verdict!.checks[key].ok).length : 0)
    return [
      { key: 'shipment', header: 'Shipment', group: 'Shipment', text: ({ row }) => `${row.number ?? ''}`, extraPx: 40 },
      { key: 'customer', header: 'Customer', group: 'Shipment', text: ({ row }) => row.customerName ?? '—', filter: 'multi', optionsOf: ({ row }) => opt(row.customerName) },
      { key: 'pod', header: 'POD', group: 'Shipment', text: () => 'POD', sortable: false, filter: false },
      { key: 'lane', header: 'Lane', group: 'Shipment', text: ({ row }) => `${row.originCity ?? '—'} → ${row.destinationCity ?? '—'}` },
      { key: 'loadStatus', header: 'Load status', group: 'Shipment', text: ({ row }) => reviewStatusText(row), filter: 'multi', optionsOf: ({ row }) => opt(boardStatusOf(row), sentence(boardStatusOf(row))), extraPx: 24 },
      { key: 'delivered', header: 'Delivered', group: 'Shipment', text: ({ row }) => deliveredText(row), sortValue: ({ row }) => deliveredTimeOf(row) ?? '' },
      { key: 'age', header: 'In review', group: 'Review', text: ({ row }) => { const age = reviewAgeDays({ deliveredAt: deliveredTimeOf(row) }, now); return age == null ? 'No delivery time' : `${age} d` }, extraPx: 24, sortValue: ({ row }) => reviewAgeDays({ deliveredAt: deliveredTimeOf(row) }, now) ?? -1 },
      { key: 'rep', header: 'Sales rep', group: 'Review', text: ({ row }) => row.salesRepName ?? '—', filter: 'multi', optionsOf: ({ row }) => opt(row.salesRepName) },
      { key: 'division', header: 'Division', group: 'Review', text: ({ row }) => row.revDivision?.replace(/_/g, ' ') ?? '—', filter: 'multi', optionsOf: ({ row }) => opt(row.revDivision?.replace(/_/g, ' ')) },
      // REQS: the board's combined list (push to load review + factoring/OTR), so both pages count the same (boardReqs.ts).
      { key: 'factoring', header: 'Reqs', group: 'Checks', text: ({ row }) => boardReqsText(boardReqsOfRow(row)), extraPx: 24, filter: 'multi', optionsOf: ({ row }) => [boardReqsOfRow(row).length > 0 ? FACTOR_INFO_OPTIONS[0] : FACTOR_INFO_OPTIONS[1]], fixedOptions: FACTOR_INFO_OPTIONS, sortValue: ({ row }) => boardReqsOfRow(row).length },
      { key: 'checks', header: 'Checks (preliminary)', group: 'Checks', text: (e) => (!e.verdict ? '' : failedOf(e) === 0 ? `All ${LOAD_REVIEW_CHECKS.length} passed` : `${failedOf(e)} to fix`), extraPx: 24 },
      ...LOAD_REVIEW_CHECKS.map((key): DenseColumn<ReviewEntry> => ({ key: `check-${key}`, header: LOAD_REVIEW_CHECK_LABEL[key], group: 'Checks', text: (e) => (!e.verdict ? '' : e.verdict.checks[key].ok ? 'Pass' : 'Fix'), extraPx: 40, filter: 'multi', optionsOf: (e) => (e.verdict ? [{ value: e.verdict.checks[key].ok ? 'Pass' : 'Fix', label: e.verdict.checks[key].ok ? 'Pass' : 'Fix' }] : []), fixedOptions: [{ value: 'Pass', label: 'Pass' }, { value: 'Fix', label: 'Fix' }] })),
      { key: 'revenue', header: 'Revenue', group: 'Review', text: ({ row }) => formatCents(row.orderRevenueCents ?? row.revenueCents ?? 0), align: 'right', sortValue: ({ row }) => row.orderRevenueCents ?? row.revenueCents ?? 0 },
      { key: 'status', header: tab === 'released' ? 'Released by / at' : 'Status', group: 'Review', text: (e) => (tab === 'released' ? 'Released by someone · 2026-01-01 00:00 Open invoicing' : e.verdict?.ok ? 'Looks ready' : `${e.verdict ? failingReasons(e.verdict).length : 0} to fix`), extraPx: 30 },
      // The checked fields with their values: NEED when the check fails, a check mark when it passes.
      ...LOAD_REVIEW_FIELDS.map((key): DenseColumn<ReviewEntry> => {
        const cellText = (e: ReviewEntry) => { const c = reviewFieldCell(e.row, e.verdict, key); return c.ok === false ? `${c.text ? `${c.text} ` : ''}✗ NEED` : `${c.text || (key === 'other' && c.ok ? 'All passed' : '')}${c.ok ? ' ✓' : ''}` }
        return { key: `field-${key}`, header: LOAD_REVIEW_FIELD_LABEL[key], group: 'Checked fields', text: cellText, extraPx: 30, filter: 'multi', optionsOf: (e) => { const c = reviewFieldCell(e.row, e.verdict, key); return c.ok == null ? [] : [{ value: c.ok ? 'OK' : 'NEED', label: c.ok ? 'OK' : 'NEED' }] }, fixedOptions: [{ value: 'OK', label: 'OK' }, { value: 'NEED', label: 'NEED' }], sortValue: fieldSort(key), align: key === 'customerRate' || key === 'carrierRate' || key === 'profit' ? 'right' : undefined }
      }),
      { key: 'ready', header: 'Ready', group: 'Checked fields', text: (e) => reviewReadyText(e.verdict), extraPx: 30, filter: 'multi', optionsOf: (e) => (e.verdict ? [{ value: e.verdict.ok ? 'Ready' : 'NEED', label: e.verdict.ok ? 'Ready' : 'NEED' }] : []), fixedOptions: [{ value: 'Ready', label: 'Ready' }, { value: 'NEED', label: 'NEED' }], sortValue: (e) => (e.verdict ? failingReasons(e.verdict).length : -1) },
      { key: 'whatToFix', header: 'What to fix', group: 'Checked fields', text: (e) => whatToFixText(e.verdict), width: WHAT_TO_FIX_PX, filter: false, sortValue: (e) => (e.verdict ? failingReasons(e.verdict).length : -1) },
    ]
  }, [tab, now])
  // One layout for every tab, so a column change on one applies to all (Ryne 2026-11-16). The v4 id starts everyone once
  // on the split customer columns (layouts saved before then are not read).
  const prefs = useDenseGridPrefs({
    gridId: 'load-review-v4',
    email,
    defaultColumns: REVIEW_TAB_COLUMNS,
    validKeys: denseCols.map((c) => c.key),
    defaultSort: null,
  })
  const gridColumns = useMemo(
    () => prefs.columns.map((k) => denseCols.find((c) => c.key === k)).filter((c): c is DenseColumn<ReviewEntry> => c != null),
    [denseCols, prefs.columns],
  )
  const setDenseFilter = useCallback((key: string, next: DenseColumnFilter | null) => {
    setPageSize(PAGE_STEP)
    setDense((prev) => { const copy = { ...prev }; if (next) copy[key] = next; else delete copy[key]; return copy })
  }, [])
  const searched = source.filter(({ row }) => matchesQuery(row, params.get('q') ?? ''))
  // The table is the same dense grid as the Shipments board: header filters on division / rep / customer, sortable columns.
  const filtered = sortDenseRows(filterRows(searched, denseCols, dense), denseCols, prefs.sort)
  const page = filtered.slice(0, pageSize)
  const fixLimit = FIX_LINE_LIMIT[prefs.density === 'comfortable' ? 'comfortable' : 'compact']
  const fixLines = prefs.columns.includes('whatToFix') ? Math.min(fixLimit, whatToFixLines(page)) : 1
  const fixRowHeights = fixLines > 1 ? { compact: Math.max(30, fixLines * 20 + 8), comfortable: Math.max(40, fixLines * 20 + 12) } : undefined
  const eligible = filtered.filter((entry) => entry.verdict?.ok)
  // Select all / deselect all (Ryne 2026-11-16): any number of rows can be ticked. Move to billing sends the clean ones in batches of
  // MAX_REVIEW_BATCH (the server's cap per call); a row that still needs fixes stays ticked for the batch edit but is never released.
  const chosen = eligible.filter(({ row }) => selected.has(row.id)).map(({ row }) => row.id)
  const editChosen = filtered.filter(({ row }) => selected.has(row.id)).map(({ row }) => row.id)
  const selectable = tab !== 'released'
  const toggleRow = (id: string) => setSelected((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const allFilteredSelected = filtered.length > 0 && filtered.every(({ row }) => selected.has(row.id))
  const toggleAllFiltered = () => setSelected(allFilteredSelected ? new Set() : new Set(filtered.map(({ row }) => row.id)))
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
      // The server takes MAX_REVIEW_BATCH shipments per call; a bigger selection goes in batches, one after another.
      const result: Awaited<ReturnType<typeof batchShipmentTask>> = { results: [] } as unknown as Awaited<ReturnType<typeof batchShipmentTask>>
      for (let offset = 0; offset < chosen.length; offset += MAX_REVIEW_BATCH) {
        const part = await batchShipmentTask({ task: 'RELEASE_TO_BILLING', shipmentIds: chosen.slice(offset, offset + MAX_REVIEW_BATCH), params: { review: { source: 'LOAD_REVIEW' } } })
        result.results.push(...part.results)
      }
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
      setNotice(result.results.map((entry) => `${entry.number ?? entry.shipmentId}: ${entry.ok ? 'Moved to billing' : entry.message}`).join('\n'))
      setConfirm(false)
      await refresh()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false); setConfirm(false) }
  }
  const columns: ColumnDef<ReviewEntry>[] = [
    { key: 'shipment', header: 'Shipment', render: ({ row }) => <><TmsButton variant="ghost" onClick={() => update({ shipment: row.id })}>{row.number}</TmsButton>{attempts[row.id] && <p>Last attempt: {attempts[row.id]}</p>}</> },
    { key: 'customer', header: 'Customer', render: ({ row }) => row.customerName ?? '—' },
    { key: 'pod', header: 'POD', render: ({ row }) => <PodPreviewButton shipmentId={row.id} number={row.number ?? null} /> },
    { key: 'lane', header: 'Lane', render: ({ row }) => `${row.originCity ?? '—'} → ${row.destinationCity ?? '—'}` },
    { key: 'loadStatus', header: 'Load status', render: ({ row }) => <span className="flex items-center gap-1"><StatusPill row={row} inReviewQueue /><DetentionPill flag={row.detentionFlag} /><TonuPill flag={row.tonuFlag} /></span> },
    { key: 'delivered', header: 'Delivered', render: ({ row }) => deliveredText(row) },
    { key: 'age', header: 'In review', render: ({ row }) => { const age = reviewAgeDays({ deliveredAt: deliveredTimeOf(row) }, now); return <span title={age == null ? NO_DELIVERY_TIME_TIP : undefined}><TmsBadge tone={age != null && age >= 7 ? 'red' : age != null && age >= 3 ? 'orange' : 'gray'}>{age == null ? 'No delivery time' : `${age} d`}</TmsBadge></span> } },
    { key: 'rep', header: 'Sales rep', render: ({ row }) => row.salesRepName ?? '—' },
    { key: 'division', header: 'Division', render: ({ row }) => row.revDivision?.replace(/_/g, ' ') ?? '—' },
    // One column per check, each a clear pass (check mark) or fail (cross) with its reason on hover, plus a result column up front:
    // "All passed" or how many need fixing.
    { key: 'factoring', header: 'Reqs', render: ({ row }) => {
      const reqs = boardReqsOfRow(row)
      return reqs.length > 0 ? <TmsBadge tone={reqs.length > 2 ? 'red' : 'orange'} title={`Needs: ${boardReqsListText(reqs)}`}>{boardReqsText(reqs)}</TmsBadge> : null
    } },
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
    ...LOAD_REVIEW_FIELDS.map((key): ColumnDef<ReviewEntry> => ({
      key: `field-${key}`,
      header: LOAD_REVIEW_FIELD_LABEL[key],
      render: ({ row, verdict }) => {
        const cell = reviewFieldCell(row, verdict, key)
        const docLink = (key === 'pod' || key === 'rateCon') && canOpen ? `/tms/shipments/${row.id}/edit#docs-${key === 'pod' ? 'POD' : 'RATE_CON'}` : null
        const value = cell.text || (key === 'other' && cell.ok ? 'All passed' : '')
        const label = docLink && (value || cell.ok === false) ? <Link to={docLink} onClick={(e) => e.stopPropagation()}>{value || 'NEED'}</Link> : <span>{value || (cell.ok === false ? 'NEED' : '')}</span>
        if (cell.ok === false) {
          const why = cell.reasons.join('; ')
          return <span className="aa-field aa-check-fail aa-fixable" data-testid={`field-${key}`} data-state="need" title={`${why} — click to fix here`} aria-label={`${LOAD_REVIEW_FIELD_LABEL[key]}: ${why}`} onClick={(e) => { e.stopPropagation(); update({ shipment: row.id, fix: key }) }}>{value && docLink == null ? <><span className="aa-field-value">{value}</span><X size={14} aria-hidden="true" /><span>NEED</span></> : <><X size={14} aria-hidden="true" />{label}</>}</span>
        }
        return <span className="aa-field" data-testid={`field-${key}`} data-state={cell.ok ? 'ok' : 'unknown'} title={cell.ok ? 'Passed' : undefined}>{label}{cell.ok && <Check size={14} aria-label="Passed" className="aa-check-pass" />}</span>
      },
    })),
    { key: 'ready', header: 'Ready', render: ({ verdict }) => {
      if (!verdict) return null
      return verdict.ok
        ? <span className="aa-field" data-testid="field-ready" data-state="ok"><Check size={14} aria-label="Ready" className="text-[color:var(--tms-badge-green)]" /><span>Ready</span></span>
        : <span className="aa-field aa-check-fail" data-testid="field-ready" data-state="need" title={failingReasons(verdict).map((r) => r.message).join('; ')}><X size={14} aria-hidden="true" /><span>{reviewReadyText(verdict)}</span></span>
    } },
    { key: 'whatToFix', header: 'What to fix', render: ({ row, verdict }) => {
      const items = verdict ? whatToFixItems(verdict) : []
      if (items.length === 0) return <span className="tms-muted" data-testid="what-to-fix">{verdict ? 'Nothing' : '—'}</span>
      const first = verdict ? LOAD_REVIEW_FIELDS.find((k) => reviewFieldCell(row, verdict, k).ok === false) : undefined
      const { shown, hidden } = fitFixItems(items, fixLimit)
      return <span className="aa-what-to-fix aa-fixable" data-testid="what-to-fix" title={`${items.join(' · ')} — click to fix in the rail`} onClick={(e) => { e.stopPropagation(); update({ shipment: row.id, fix: first ?? null }) }}>{shown.map((text) => <span key={text} className="aa-fix-item">{text}</span>)}{hidden > 0 && <span className="aa-fix-item aa-fix-more" data-testid="what-to-fix-more">+{hidden} more</span>}</span>
    } },
    { key: 'status', header: tab === 'released' ? 'Released by / at' : 'Status', render: ({ row, verdict }) => { if (tab === 'released') { const entry = audit[row.id] ?? (row.orderIds ?? []).map((id) => audit[id]).find(Boolean); return <>{entry?.user ?? 'Audit unavailable'} · {formatDateTime(entry?.at ?? row.readyToInvoiceAt)} {canOpen && <Link to={`/tms/shipments/${row.id}/edit?tab=invoicing`}>Open invoicing</Link>}</> } return <TmsBadge tone={verdict?.ok ? 'green' : 'orange'}>{verdict?.ok ? 'Looks ready' : `${verdict ? failingReasons(verdict).length : 0} to fix`}</TmsBadge> } },
  ]
  const renderReviewCell = (entry: ReviewEntry, key: string) => columns.find((c) => c.key === key)?.render(entry) ?? null
  return <div className="aa-load-review">
    {error && <TmsAlert tone="red">{error}</TmsAlert>}{auditError && <TmsAlert tone="red">{auditError}</TmsAlert>}
    {notice && <div role="status" className="aa-review-results" style={{ whiteSpace: 'pre-line' }}>{notice}</div>}
    <div className="tms-dense-page tms-caps">
      <TmsTabStrip
        aria-label="Load review filters"
        active={tab}
        onSelect={(key) => { update({ tab: key, page: null }); setSelected(new Set()); setPageSize(PAGE_STEP) }}
        tabs={[{ key: 'all', label: 'All in review', count: queue.length }, { key: 'fixes', label: 'Needs fixes', count: needs.length }, { key: 'ready', label: 'Looks ready', count: ready.length }, { key: 'released', label: 'Released (14 d)', count: released.length }]}
      />
      <div className="tms-dense-bar">
        <span className="tms-dense-title"><ClipboardCheck size={18} aria-hidden="true" /> Review · Load review</span>
        <Search size={14} className="tms-muted" aria-hidden="true" />
        <TmsInput className="tms-dense-search" aria-label="Search review queue" placeholder="Shipment, customer or reference" value={params.get('q') ?? ''} onChange={(e) => { update({ q: e.target.value, page: null }); setPageSize(PAGE_STEP) }} />
        {tab !== 'released' && <><TmsButton data-testid="review-select-ready" disabled={eligible.length === 0} onClick={() => setSelected(new Set(eligible.map(({ row }) => row.id)))}>Select all looks ready ({eligible.length})</TmsButton><TmsButton data-testid="review-select-all" disabled={filtered.length === 0} onClick={() => setSelected(new Set(filtered.map(({ row }) => row.id)))}>Select all ({filtered.length})</TmsButton>{selected.size > 0 && <TmsButton data-testid="review-deselect-all" onClick={() => setSelected(new Set())}>Deselect all</TmsButton>}<TmsButton disabled={busy} data-testid="review-pull-ready" title="Delivered shipments with their references, sales rep, order details and documents move in by themselves; this sweeps any that are waiting" onClick={() => { setBusy(true); pushReadyToLoadReview().then((r) => { setNotice(`${r.pushed} delivered shipment${r.pushed === 1 ? '' : 's'} moved into Load Review (${r.checked} checked)`); void refresh() }).catch((e: unknown) => setNotice(e instanceof Error ? e.message : 'Could not sweep')).finally(() => setBusy(false)) }}>Move ready loads in</TmsButton></>}
        <ClearFiltersButton count={activeFilterCount(dense)} onClear={() => { setDense({}); setPageSize(PAGE_STEP) }} />
        <span className="tms-dense-spacer" />
        <TmsButton size="sm" variant="secondary" onClick={() => void refresh()}>Refresh</TmsButton>
        <TmsButton size="sm" variant="secondary" data-testid="export-load-review" title="Every shipment in Load Review with every field and each check" onClick={() => toast.success(`Exported ${exportRecords('load-review', queue.map((e) => reviewExportRow(e.row, e.verdict)))} shipments in Load Review`)}>
          <Download size={14} aria-hidden="true" /> Export all
        </TmsButton>
        <ColumnsButton sharedWithAll={prefs.layoutSharedWithAll} catalog={denseCols.filter((c) => c.key !== 'select')} columns={prefs.columns} widths={prefs.widths} pinned={prefs.pinned} onApply={(next) => prefs.applyLayout({ ...next, replaceWidths: true })} />
        <DensityToggle density={prefs.density} onChange={prefs.setDensity} />
      </div>
      <DenseKpiStrip open items={[
        { label: 'In review', value: queue.length },
        { label: 'Looks ready', value: ready.length },
        { label: 'Needs fixes', value: needs.length, tone: needs.length > 0 ? 'warn' : undefined },
        { label: 'Oldest', value: `${Math.max(0, ...queue.map(({ row }) => reviewAgeDays({ deliveredAt: deliveredTimeOf(row) }, now) ?? 0))} d` },
        { label: 'Value in review', value: formatCents(queue.reduce((sum, { row }) => sum + (row.orderRevenueCents ?? row.revenueCents ?? 0), 0)) },
      ]} />
      <div className="tms-dense-body">
        <DenseGrid<ReviewEntry>
          aria-label="Load review"
          recentKey={`tms:load-review:recent:${email || 'anon'}`}
          resetKey={`${tab}|${params.get('q') ?? ''}|${JSON.stringify(dense)}`}
          columns={gridColumns}
          rows={page}
          fitRows={filtered}
          rowKey={({ row }) => row.id}
          renderCell={renderReviewCell}
          toneOf={tab === 'all' ? reviewRowTone : undefined}
          density={prefs.density}
          rowHeights={fixRowHeights}
          userWidths={prefs.widths}
          stickyCount={Math.max(2, prefs.pinned.length + 1)}
          sort={prefs.sort}
          onSort={(key) => prefs.setSort(nextSort(prefs.sort, key))}
          filters={dense}
          onFilterChange={setDenseFilter}
          onReorder={(from, to) => prefs.setColumns(reorderKeys(prefs.columns, from, to))}
          onResize={prefs.setWidth}
          selectable={selectable}
          selectedIds={selected}
          onToggle={toggleRow}
          onToggleAll={toggleAllFiltered}
          checkLabel={({ row }) => `Select ${row.number ?? row.id}`}
          checkTitle={({ verdict }) => (verdict && !verdict.ok ? failingReasons(verdict)[0]?.message : undefined)}
          onRowClick={({ row }) => update({ shipment: row.id, fix: null })}
          empty={loading || partial ? 'Loading review queue…' : queue.length ? 'Nothing here.' : 'Nothing is waiting for review.'}
        />
        {filtered.length > page.length && (
          <div className="tms-dense-bar" data-testid="review-more">
            <span className="tms-muted">Showing {page.length} of {filtered.length}</span>
            <TmsButton size="sm" variant="secondary" onClick={() => setPageSize((n) => n + PAGE_STEP)}>Show next {PAGE_STEP}</TmsButton>
          </div>
        )}
      </div>
      {selectable && editChosen.length > 0 && (
        <div className="aa-review-bulk" data-testid="review-bulk-bar">
          <strong>{editChosen.length} selected</strong>
          {chosen.length !== editChosen.length && <span className="tms-muted">{chosen.length} look ready</span>}
          <ReviewBatchEdit ids={editChosen} email={email} onDone={() => { setSelected(new Set()); void refresh() }} />
          <span className="tms-dense-spacer" />
          <TmsButton size="sm" onClick={() => setSelected(new Set())}>Deselect all</TmsButton>
          <TmsButton variant="primary" disabled={!canRelease || chosen.length === 0} title={!canRelease ? LOAD_REVIEW_GRANT_MESSAGE : chosen.length === 0 ? 'Only shipments that look ready can move to billing' : chosen.length > MAX_REVIEW_BATCH ? `Sent in batches of ${MAX_REVIEW_BATCH}` : undefined} onClick={() => setConfirm(true)}>Move {chosen.length} to billing</TmsButton>
          {!canRelease && <p role="note" className="tms-muted">{LOAD_REVIEW_GRANT_MESSAGE}</p>}
        </div>
      )}
    </div>
    <TmsDialog open={confirm} onOpenChange={setConfirm} title={`Move ${chosen.length} to billing`} description={`These ${chosen.length} shipments go to accounting. The server re-checks each one.`} footer={<TmsButton disabled={busy || !chosen.length} variant="primary" onClick={() => void releaseBatch()}>Confirm move to billing</TmsButton>} />
    {openRow && <LoadReviewDrawer key={`${openRow.id}:${params.get('fix') ?? ''}`} row={openRow} focus={params.get('fix')} onClose={() => update({ shipment: null, fix: null })} onRefresh={refresh} onFailure={(message) => setAttempts((old) => ({ ...old, [openRow.id]: message }))} onMoved={() => { setNotice(`${openRow.number}: Moved to billing`); const index = filtered.findIndex(({ row }) => row.id === openRow.id); update({ shipment: filtered[index + 1]?.row.id ?? null }) }} />}
  </div>
}
