/**
 * The Documents workstation: the collection queue between delivery and billing.
 *
 * One row per shipment answers the three questions somebody chasing paperwork actually
 * asks — what does this customer's billing require, what is already in hand (and where
 * it came from), and what is still missing — and one panel per selected row carries the
 * file list, the release gate's own verdict, and the release action. The rules are never
 * restated here: required types and presence come from the release gate's own functions
 * (via `documentMatrix`), the gate verdict comes from `ReleaseGateCard` asking the server,
 * and **Release to billing** is the same READY_TO_INVOICE action the Invoicing tab runs —
 * a refusal prints the gate's reasons verbatim.
 *
 * The narrowing is the shared `useBoardFilters` panel, so the facets and saved views a
 * user learns on the Shipments board work identically here; the page starts on the
 * collection queue (delivered, documents still missing) and Reset Filters returns to it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Eye, FileCheck2, Inbox, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsDialog, TmsField, TmsInput } from '@/features/tms/kit'
import { BoardFilterPanel } from '../board/BoardFilterPanel'
import { teamRepIdsFor, useBoardFilters } from '../board/useBoardFilters'
import { BoardCheckbox } from '../board/parts'
import { ReleaseGateCard, ReleaseGateList } from '../components/ReleaseGateCard'
import { releaseGateMessages } from '../components/releaseGateView'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import { documentMatrix, DOCUMENT_SOURCE_LABELS, formatSize, type DocumentMatrix } from './documentMatrix'
import { useAuth } from '@/hooks/useAuth'
import { useDirectory } from '@/hooks/useDirectory'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
import { useShipments } from '@/hooks/useShipments'
import { useStaff } from '@/hooks/useStaff'
import { useShipmentViews } from '@/features/tms/useShipmentViews'
import { viewCallerOf, viewsVisibleTo } from '@/lib/shipmentViewDefs'
import {
  getShipmentBundle,
  getShipmentDocumentUrl,
  getTmsSettings,
  listShipmentMessages,
  readyToInvoice,
  previewInvoice,
  requestPod,
  reviewShipmentPod,
} from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { EMPTY_BOARD_FILTER_SET } from '../shipmentViews'
import { PodReviewCard } from './documents/PodReviewCard'
import type { PodReviewOutcome } from '@/lib/apiClient'
import type {
  CustomerRecord,
  BoardFilterSet,
  ShipmentBundle,
  ShipmentDocumentRecord,
  ShipmentMessageRecord,
  TmsSettings,
} from '@/types/tms'

/**
 * The workstation's reason to exist, as a filter set: freight that has been delivered
 * and still owes somebody a document. Reset Filters in the panel comes back here.
 */
const COLLECTION_QUEUE: BoardFilterSet = {
  ...EMPTY_BOARD_FILTER_SET,
  statuses: ['DELIVERED'],
  flags: { docsMissing: true },
}

export function DocumentsWorkstation() {
  const navigate = useNavigate()
  const { slug } = useParams<{ slug?: string }>()
  const { isAdmin, isOwner, user } = useAuth()
  const { shipments: rawRows, loading, error, refresh } = useShipments()
  const { customers } = useDirectory()
  const staff = useStaff(user?.email)
  const viewsState = useShipmentViews()
  const reviewQueue = useDocumentReviewQueue()

  const [settings, setSettings] = useState<TmsSettings | null>(null)
  const [bundles, setBundles] = useState<Record<string, ShipmentBundle>>({})
  const [bundleErrors, setBundleErrors] = useState<Record<string, string>>({})
  const [readyIds, setReadyIds] = useState<Record<string, boolean>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)
  const [messages, setMessages] = useState<Record<string, ShipmentMessageRecord[]>>({})
  const [requestingPod, setRequestingPod] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const [viewShared, setViewShared] = useState(false)
  const [saving, setSaving] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getTmsSettings().then((s) => { if (!cancelled) setSettings(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const caller = useMemo(
    () => viewCallerOf({ groups: user?.groups, divisions: staff.me?.divisions, isOwner, isAdmin }),
    [user?.groups, staff.me?.divisions, isOwner, isAdmin],
  )
  const visibleViews = useMemo(() => viewsVisibleTo(viewsState.views, caller), [viewsState.views, caller])

  const viewer = useMemo(
    () => ({ userId: user?.userId ?? null, teamRepIds: teamRepIdsFor(staff.me, settings?.teams) }),
    [user?.userId, staff.me, settings?.teams],
  )

  const board = useBoardFilters({
    rows: rawRows,
    customers,
    staffNameOf: staff.nameOf,
    views: visibleViews,
    viewSlug: slug ?? '',
    onSelectView: (next) => navigate(next ? `/tms/documents/view/${next}` : '/tms/documents'),
    onViewsChanged: () => { void viewsState.refresh() },
    onCreateView: () => { setViewName(''); setViewShared(false); setSaveOpen(true) },
    storageKey: 'tms-documents',
    baseFilters: COLLECTION_QUEUE,
    viewer,
  })
  const { rows } = board

  // Cache reads across filter changes; an in-flight read still belongs to its
  // shipment when another row is selected or the visible set changes.
  const rowIds = useMemo(() => rows.map((r) => r.id).sort().join(','), [rows])
  const asked = useRef<Set<string>>(new Set())
  const reloadBundle = useCallback(async (id: string) => {
    asked.current.add(id)
    try {
      const bundle = await getShipmentBundle(id)
      setBundles((prev) => ({ ...prev, [id]: bundle }))
      setBundleErrors((prev) => ({ ...prev, [id]: '' }))
      const order = bundle.orders[0]
      if (order && !order.readyToInvoiceAt && !order.invoiceId) {
        const preview = await previewInvoice({ orderId: order.id })
        setReadyIds((prev) => ({ ...prev, [id]: preview.releaseGate.ok }))
      } else {
        setReadyIds((prev) => ({ ...prev, [id]: false }))
      }
    } catch (err) {
      asked.current.delete(id)
      setReadyIds((prev) => ({ ...prev, [id]: false }))
      setBundleErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Could not read the documents' }))
    }
  }, [])
  useEffect(() => {
    for (const id of rowIds ? rowIds.split(',') : []) {
      if (!asked.current.has(id)) void reloadBundle(id)
    }
  }, [rowIds, reloadBundle])

  // The thread is where POD requests and replies live; load it when a row is selected
  // so the panel can say whether a request went out and which attachment it produced.
  useEffect(() => {
    if (!selectedId) return
    let live = true
    listShipmentMessages(selectedId)
      .then((rows) => {
        if (!live) return
        setMessages((prev) => ({ ...prev, [selectedId]: rows }))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [selectedId])

  const customerById = useMemo<Record<string, CustomerRecord>>(() => {
    const map: Record<string, CustomerRecord> = {}
    for (const c of customers) map[c.id] = c
    return map
  }, [customers])

  const matrices = useMemo(() => {
    const map: Record<string, DocumentMatrix> = {}
    for (const row of rows) {
      const bundle = bundles[row.id]
      if (!bundle) continue
      map[row.id] = documentMatrix({
        documents: bundle.documents,
        loads: bundle.loads,
        orders: bundle.orders,
        loadCarriers: bundle.loadCarriers,
        customer: row.customerId ? customerById[row.customerId] : null,
        settings,
      })
    }
    return map
  }, [rows, bundles, customerById, settings])

  const selected = rows.find((r) => r.id === selectedId) ?? null
  const selectedBundle = selected ? bundles[selected.id] ?? null : null
  const selectedOrder = selectedBundle?.orders[0] ?? null
  const selectedMatrix = selected ? matrices[selected.id] ?? null : null

  const missingCount = rows.filter((r) => matrices[r.id] ? matrices[r.id].missingCount > 0 : (r.docsMissing?.length ?? 0) > 0).length
  const readyCount = rows.filter((r) => readyIds[r.id]).length

  const openPreview = (doc: ShipmentDocumentRecord) => {
    setPreview({ doc, url: null })
    getShipmentDocumentUrl(doc.s3Key)
      .then((url) => setPreview((prev) => (prev?.doc.id === doc.id ? { doc, url } : prev)))
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Could not open that file')
        setPreview((prev) => (prev?.doc.id === doc.id ? null : prev))
      })
  }

  const requestPodForSelected = async () => {
    if (!selected) return
    setRequestingPod(true)
    try {
      await requestPod({ shipmentId: selected.id })
      toast.success('POD requested')
      const rows = await listShipmentMessages(selected.id)
      setMessages((prev) => ({ ...prev, [selected.id]: rows }))
      await reloadBundle(selected.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'POD request failed')
    } finally {
      setRequestingPod(false)
    }
  }

  const reviewPod = async (documentId: string): Promise<PodReviewOutcome> => {
    if (!selected) throw new Error('No shipment selected')
    const outcome = await reviewShipmentPod({ shipmentId: selected.id, documentId })
    await reloadBundle(selected.id)
    return outcome
  }

  const release = async () => {
    if (!selected || !selectedOrder) return
    setReleasing(true)
    setReleaseError(null)
    try {
      await readyToInvoice({ orderId: selectedOrder.id, expectedUpdatedAt: selectedOrder.updatedAt })
      toast.success('Released to billing')
      await reloadBundle(selected.id)
      refresh()
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : 'Release failed')
    } finally {
      setReleasing(false)
    }
  }

  const saveViewAs = async () => {
    const name = viewName.trim()
    if (!name) return
    setSaving(true)
    try {
      await board.createView(name, viewShared)
      toast.success('View saved')
      setSaveOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const gateMessages = releaseError ? releaseGateMessages(releaseError) : null

  return (
    <div className="tms-board-shell flex h-full flex-col">
      <div className="tms-board-toolbar flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-3">
          <FileCheck2 size={18} />
          <span className="font-semibold">Documents</span>
          <span className="tms-muted text-sm" data-testid="doc-counts">
            {rows.length} shipments · {missingCount} missing a document · {readyCount} ready to release
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/tms/documents/review"
            className="inline-flex items-center gap-1.5 text-sm text-[color:var(--tms-muted)] hover:text-[color:var(--tms-text)]"
          >
            <Inbox size={14} />
            Carrier-upload review
            {` · ${reviewQueue.pendingCount} waiting`}
          </Link>
          <TmsInput
            placeholder="Search"
            value={board.query}
            onChange={(e) => board.setQuery(e.target.value)}
            className="h-8 w-64"
          />
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <BoardFilterPanel {...board.panelProps} />

        <div className="min-w-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="p-4 text-sm text-[color:var(--tms-badge-red)]">{error}</p>
          ) : loading && rows.length === 0 ? (
            <p className="tms-muted p-4 text-sm">Loading shipments…</p>
          ) : rows.length === 0 ? (
            <p className="tms-muted p-4 text-sm">
              Nothing matches. The collection queue is delivered freight that still owes a
              document — widen the filters to look further.
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--tms-border)]">
              {rows.map((row) => {
                const matrix = matrices[row.id]
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`doc-row-${row.id}`}
                      aria-pressed={selectedId === row.id}
                      onClick={() => { setReleaseError(null); setSelectedId(row.id) }}
                      className={`block w-full px-3 py-2 text-left hover:bg-[color:var(--tms-topbar)] ${
                        selectedId === row.id ? 'bg-[color:var(--tms-topbar)]' : ''
                      }`}
                    >
                      <div className="flex items-baseline gap-3">
                        <span className="font-semibold">{row.number}</span>
                        <span className="truncate">{(row.customerId ? customerById[row.customerId]?.name : null) ?? row.customerName ?? '—'}</span>
                        <span className="tms-muted truncate">{row.carrierName ?? '—'}</span>
                        <span className="tms-muted ml-auto shrink-0 text-xs">
                          Delivered {formatDateTime(row.deliveredAt)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {matrix
                          ? matrix.chips.map((chip) => (
                              chip.present ? (
                                <TmsBadge
                                  key={chip.type}
                                  tone="green"
                                  data-testid={`chip-${chip.type}`}
                                  data-present="true"
                                  title={
                                    chip.derivedFromSignedRateCon
                                      ? `${chip.label}: the carrier signed the rate confirmation`
                                      : chip.doc
                                        ? `${chip.label}: ${DOCUMENT_SOURCE_LABELS[chip.doc.source]} ${formatDateTime(chip.doc.uploadedAt)}`
                                        : chip.label
                                  }
                                >
                                  {chip.label}
                                  {chip.doc ? ` · ${DOCUMENT_SOURCE_LABELS[chip.doc.source]}` : chip.derivedFromSignedRateCon ? ' · signed carrier packet' : ''}
                                </TmsBadge>
                              ) : (
                                <span
                                  key={chip.type}
                                  data-testid={`chip-${chip.type}`}
                                  data-present="false"
                                  title={`${chip.label}: still missing`}
                                  className="inline-flex items-center rounded border border-dashed border-[color:var(--tms-input-border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--tms-muted)]"
                                >
                                  {chip.label}
                                </span>
                              )
                            ))
                          : <span className="tms-muted text-xs">{bundleErrors[row.id] || 'Checking documents…'}</span>}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {selected && (
          <aside
            data-testid="doc-detail"
            className="w-[26rem] shrink-0 space-y-3 overflow-y-auto border-l border-[color:var(--tms-border)] p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{selected.number}</div>
                <div className="tms-muted text-sm">{(selected.customerId ? customerById[selected.customerId]?.name : null) ?? selected.customerName ?? '—'}</div>
              </div>
              <TmsButton size="sm" variant="ghost" aria-label="Close detail" onClick={() => setSelectedId(null)}>
                <X size={14} />
              </TmsButton>
            </div>
            {bundleErrors[selected.id] && (
              <div role="alert" className="space-y-2 text-sm">
                <p>{bundleErrors[selected.id]}</p>
                <TmsButton size="sm" onClick={() => { void reloadBundle(selected.id) }}>Retry document check</TmsButton>
              </div>
            )}

            {!selectedBundle ? (
              <p className="tms-muted text-sm">{bundleErrors[selected.id] ? 'The shipment could not be loaded.' : 'Loading the shipment…'}</p>
            ) : (
              <>
                <ReleaseGateCard shipment={selectedBundle.shipment} order={selectedOrder} />

                <PodReviewCard
                  shipment={selectedBundle.shipment}
                  documents={selectedBundle.documents}
                  messages={messages[selected.id] ?? []}
                  requesting={requestingPod}
                  onRequestPod={requestPodForSelected}
                  onReviewPod={reviewPod}
                />

                <TmsCard title="Documents on this shipment">
                  {selectedBundle.documents.length === 0 ? (
                    <p className="tms-muted text-sm">No documents are filed on this shipment yet.</p>
                  ) : (
                    <ul className="divide-y divide-[color:var(--tms-border)]" data-testid="doc-file-list">
                      {[...selectedBundle.documents]
                        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
                        .map((doc) => (
                          <li key={doc.id} className="flex items-center justify-between gap-2 py-1.5">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <TmsBadge tone={doc.status === 'ACTIVE' ? 'blue' : 'gray'}>
                                  {doc.type.replace(/_/g, ' ')}
                                </TmsBadge>
                                <span className="truncate text-sm">{doc.name}</span>
                              </div>
                              <div className="tms-muted mt-0.5 text-xs">
                                {formatSize(doc.sizeBytes)} · {DOCUMENT_SOURCE_LABELS[doc.source]} ·{' '}
                                {formatDateTime(doc.uploadedAt)}
                                {doc.reviewStatus === 'PENDING' ? ' · waiting on review' : ''}
                                {doc.reviewStatus === 'REJECTED' ? ' · rejected' : ''}
                                {doc.status !== 'ACTIVE' ? ` · ${doc.status.toLowerCase()}` : ''}
                              </div>
                            </div>
                            <TmsButton size="sm" onClick={() => openPreview(doc)}>
                              <Eye size={13} />
                              View
                            </TmsButton>
                          </li>
                        ))}
                    </ul>
                  )}
                  {selectedMatrix && selectedMatrix.unrecognised.length > 0 && (
                    <p className="tms-muted mt-2 text-xs">
                      This customer also asks for: {selectedMatrix.unrecognised.join(', ')} — not a
                      document type the gate knows, so a person has to check it.
                    </p>
                  )}
                </TmsCard>

                <TmsCard title="Release to billing">
                  {!selectedOrder ? (
                    <p className="tms-muted text-sm">
                      This shipment has no order yet, so there is nothing to release.
                    </p>
                  ) : selectedOrder.readyToInvoiceAt || selectedOrder.invoiceId ? (
                    <p className="text-sm" data-testid="doc-released">
                      Already released to accounting
                      {selectedOrder.readyToInvoiceAt ? ` ${formatDateTime(selectedOrder.readyToInvoiceAt)}` : ''}.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <TmsButton
                        variant="primary"
                        disabled={releasing}
                        onClick={() => { void release() }}
                      >
                        {releasing ? 'Releasing…' : 'Release to billing'}
                      </TmsButton>
                      {gateMessages ? (
                        <ReleaseGateList messages={gateMessages} testId="release-refusal" />
                      ) : releaseError ? (
                        <p className="text-sm text-[color:var(--tms-badge-red)]">{releaseError}</p>
                      ) : null}
                      <p className="tms-muted text-xs">
                        The gate decides — a refusal above is its own answer, nothing here goes around it.
                      </p>
                    </div>
                  )}
                </TmsCard>
              </>
            )}
          </aside>
        )}
      </div>

      {preview && (
        <DocumentPreview
          open
          onClose={() => setPreview(null)}
          title={`${preview.doc.type.replace(/_/g, ' ')} · ${preview.doc.name}`}
          subtitle={`${DOCUMENT_SOURCE_LABELS[preview.doc.source]} · ${preview.doc.uploadedBy} · ${formatDateTime(preview.doc.uploadedAt)}`}
          url={preview.url}
          contentType={preview.doc.contentType}
          downloadName={preview.doc.name}
        />
      )}

      <TmsDialog
        open={saveOpen}
        onOpenChange={(open) => { if (!open && !saving) setSaveOpen(false) }}
        title="Save as view"
        footer={
          <>
            <TmsButton onClick={() => setSaveOpen(false)} disabled={saving}>Cancel</TmsButton>
            <TmsButton variant="primary" disabled={saving || !viewName.trim()} onClick={() => { void saveViewAs() }}>
              {saving ? 'Saving…' : 'Save view'}
            </TmsButton>
          </>
        }
      >
        <div className="grid gap-3">
          <TmsField label="View name">
            <TmsInput
              aria-label="View name"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder="POD chase"
            />
          </TmsField>
          <BoardCheckbox
            id="doc-view-shared"
            label="Shared with the team"
            checked={viewShared}
            onChange={setViewShared}
          />
        </div>
      </TmsDialog>
    </div>
  )
}

export default DocumentsWorkstation
