/**
 * Review the files carriers sent through a public upload link: preview, accept, reject.
 *
 * Nothing a carrier uploads satisfies a required-document gate until somebody accepts it
 * here. The carrier also chose the type from a dropdown on a phone at a dock, which is why
 * accepting asks for the type again: a lumper receipt filed as a POD would satisfy the wrong
 * gate, and retyping on the way in is cheaper than finding it later.
 *
 * Queue-agnostic: the caller hands in the documents (the Tracking grid's row action filters
 * the shared review queue to one shipment) and learns of each decision through `onDecided`.
 * The shipment, load and carrier names are not on the document row, so each distinct
 * shipment's bundle is read once and cached for as long as the panel is mounted.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Eye, X } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsField, TmsSelect, TmsTable, TmsTextarea } from '@/features/tms/kit'
import type { ColumnDef } from '@/features/tms/kit'
import { getShipmentBundle, getShipmentDocumentUrl, reviewDocument } from '@/lib/apiClient'
import { CARRIER_UPLOADABLE_TYPES, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { formatDateTime } from '@/lib/date'
import { DocumentPreview } from './DocumentPreview'
import type { ShipmentBundle, ShipmentDocumentRecord, ShipmentDocumentType } from '@/types/tms'

/** What a row needs from its shipment that the document row does not carry. */
interface ShipmentContext {
  number: string
  loadNumbers: Record<string, string>
  carrierNames: Record<string, string>
  loadCarrierNames: Record<string, string>
}

function summarize(bundle: ShipmentBundle): ShipmentContext {
  const loadNumbers: Record<string, string> = {}
  const carrierNames: Record<string, string> = {}
  for (const load of bundle.loads) {
    if (load.loadNumber) loadNumbers[load.id] = load.loadNumber
    if (load.carrierName) carrierNames[load.id] = load.carrierName
  }
  const loadCarrierNames: Record<string, string> = {}
  for (const lc of bundle.loadCarriers) {
    if (lc.carrierName) loadCarrierNames[lc.id] = lc.carrierName
  }
  return { number: bundle.shipment.number ?? bundle.shipment.id, loadNumbers, carrierNames, loadCarrierNames }
}

/** KB below a megabyte: "0.1 MB" tells a reviewer nothing about a 90 KB photo. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface DocumentReviewPanelProps {
  documents: ShipmentDocumentRecord[]
  /** After an accept or reject was recorded; the caller refreshes its queue. */
  onDecided: () => void | Promise<unknown>
  emptyText?: string
}

export function DocumentReviewPanel({ documents, onDecided, emptyText }: DocumentReviewPanelProps) {
  const [context, setContext] = useState<Record<string, ShipmentContext>>({})
  const [preview, setPreview] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)
  const [accepting, setAccepting] = useState<ShipmentDocumentRecord | null>(null)
  const [acceptType, setAcceptType] = useState<ShipmentDocumentType>('POD')
  const [rejecting, setRejecting] = useState<ShipmentDocumentRecord | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // A primitive the effect can depend on; the document array may be rebuilt by every poll.
  const shipmentIds = useMemo(
    () => Array.from(new Set(documents.map((d) => d.shipmentId))).sort().join(','),
    [documents],
  )
  // Which bundles have been asked for. A ref, not state, so asking does not re-render
  // and the effect does not depend on what it writes.
  const asked = useRef<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    const wanted = (shipmentIds ? shipmentIds.split(',') : []).filter((id) => !asked.current.has(id))
    for (const id of wanted) asked.current.add(id)
    for (const id of wanted) {
      getShipmentBundle(id)
        .then((bundle) => { if (alive) setContext((prev) => ({ ...prev, [id]: summarize(bundle) })) })
        // Forget the failure so the next poll tries again; a row without its names still
        // lists, because a file waiting on review matters more than its load number.
        .catch(() => { asked.current.delete(id) })
    }
    return () => { alive = false }
  }, [shipmentIds])

  const openPreview = (doc: ShipmentDocumentRecord) => {
    setPreview({ doc, url: null })
    getShipmentDocumentUrl(doc.s3Key)
      .then((url) => setPreview((prev) => (prev?.doc.id === doc.id ? { doc, url } : prev)))
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Could not open that file')
        setPreview((prev) => (prev?.doc.id === doc.id ? null : prev))
      })
  }

  const startAccept = (doc: ShipmentDocumentRecord) => {
    const claimed = (CARRIER_UPLOADABLE_TYPES as readonly ShipmentDocumentType[]).includes(doc.type)
      ? doc.type
      : CARRIER_UPLOADABLE_TYPES[0]
    setAcceptType(claimed)
    setAccepting(doc)
  }

  const decide = async (input: Parameters<typeof reviewDocument>[0], done: string) => {
    setBusy(true)
    try {
      await reviewDocument(input)
      toast.success(done)
      setAccepting(null)
      setRejecting(null)
      setNote('')
      await onDecided()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record that decision')
    } finally {
      setBusy(false)
    }
  }

  const nameFor = (doc: ShipmentDocumentRecord) => {
    const ctx = context[doc.shipmentId]
    const loadNumber = doc.loadId ? ctx?.loadNumbers[doc.loadId] : undefined
    const carrier = (doc.loadCarrierId ? ctx?.loadCarrierNames[doc.loadCarrierId] : undefined)
      ?? (doc.loadId ? ctx?.carrierNames[doc.loadId] : undefined)
    return { shipment: loadNumber ?? ctx?.number ?? doc.shipmentId, carrier }
  }

  const columns: Array<ColumnDef<ShipmentDocumentRecord>> = [
    { key: 'received', header: 'RECEIVED', width: 150, render: (doc) => formatDateTime(doc.uploadedAt) },
    {
      key: 'shipment',
      header: 'SHIPMENT · LOAD',
      width: 150,
      render: (doc) => <span style={{ fontWeight: 600 }}>{nameFor(doc).shipment}</span>,
    },
    { key: 'carrier', header: 'CARRIER', width: 160, render: (doc) => nameFor(doc).carrier ?? '—' },
    { key: 'type', header: 'CLAIMED TYPE', width: 140, render: (doc) => <TmsBadge tone="purple">{DOCUMENT_TYPE_LABELS[doc.type]}</TmsBadge> },
    { key: 'file', header: 'FILE', width: 200, render: (doc) => doc.name },
    { key: 'size', header: 'SIZE', width: 80, render: (doc) => <span className="tms-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatSize(doc.sizeBytes)}</span> },
    {
      key: 'actions',
      header: '',
      width: 260,
      render: (doc) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <TmsButton size="sm" onClick={() => openPreview(doc)}><Eye size={13} />Preview</TmsButton>
          <TmsButton variant="primary" size="sm" disabled={busy} onClick={() => startAccept(doc)}><Check size={13} />Accept</TmsButton>
          <TmsButton size="sm" disabled={busy} onClick={() => { setNote(''); setRejecting(doc) }}><X size={13} />Reject</TmsButton>
        </div>
      ),
    },
  ]

  return (
    <>
      <TmsTable<ShipmentDocumentRecord>
        columns={columns}
        rows={documents}
        rowKey={(doc) => doc.id}
        empty={emptyText ?? 'Nothing is waiting on review. Files carriers send through an upload link land here; nothing counts towards a required document until it is accepted.'}
      />

      {preview && (
        <DocumentPreview
          open
          onClose={() => setPreview(null)}
          title={`${DOCUMENT_TYPE_LABELS[preview.doc.type]} · ${preview.doc.name}`}
          subtitle={`Uploaded ${formatDateTime(preview.doc.uploadedAt)} by ${preview.doc.uploadedBy}`}
          url={preview.url}
          contentType={preview.doc.contentType}
          downloadName={preview.doc.name}
        />
      )}

      {accepting && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open && !busy) setAccepting(null) }}
          title="Accept this document"
          footer={
            <>
              <TmsButton onClick={() => setAccepting(null)} disabled={busy}>Cancel</TmsButton>
              <TmsButton
                variant="primary"
                disabled={busy}
                onClick={() => {
                  void decide(
                    { documentId: accepting.id, decision: 'ACCEPT', type: acceptType },
                    'Document accepted',
                  )
                }}
              >
                {busy ? 'Saving…' : 'Accept'}
              </TmsButton>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 14 }}>
            <p className="tms-muted" style={{ fontSize: 13 }}>
              {accepting.name} — the carrier filed this as {DOCUMENT_TYPE_LABELS[accepting.type]}. Confirm
              what it actually is; that is the type the shipment keeps.
            </p>
            <TmsField label="Document type">
              <TmsSelect
                aria-label="Confirmed document type"
                value={acceptType}
                onChange={(e) => setAcceptType(e.target.value as ShipmentDocumentType)}
                options={CARRIER_UPLOADABLE_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] }))}
              />
            </TmsField>
          </div>
        </TmsDialog>
      )}

      {rejecting && (
        <TmsDialog
          open
          onOpenChange={(open) => { if (!open && !busy) { setRejecting(null); setNote('') } }}
          title="Reject this document"
          footer={
            <>
              <TmsButton onClick={() => { setRejecting(null); setNote('') }} disabled={busy}>Cancel</TmsButton>
              <TmsButton
                variant="destructive"
                disabled={busy || !note.trim()}
                onClick={() => {
                  void decide(
                    { documentId: rejecting.id, decision: 'REJECT', note: note.trim() },
                    'Document rejected',
                  )
                }}
              >
                {busy ? 'Saving…' : 'Reject'}
              </TmsButton>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 14 }}>
            <p className="tms-muted" style={{ fontSize: 13 }}>
              {rejecting.name} — the note is what the carrier is told, so say what is wrong
              with it and what to send instead.
            </p>
            <TmsField label="Why it is being rejected">
              <TmsTextarea
                aria-label="Rejection note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Page 2 is cut off — please re-send the whole POD"
              />
            </TmsField>
          </div>
        </TmsDialog>
      )}
    </>
  )
}
