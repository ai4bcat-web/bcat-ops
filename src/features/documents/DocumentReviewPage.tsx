/**
 * The carrier-upload review queue: every file a carrier sent through a public upload
 * link that nobody has looked at yet.
 *
 * Nothing a carrier uploads satisfies a required-document gate until somebody accepts
 * it here, so this page is the only thing standing between "the carrier says they sent
 * the POD" and an order that is clear to invoice. The carrier also chose the type from
 * a dropdown on a phone at a dock, which is why accepting asks for the type again: a
 * lumper receipt filed as a POD would satisfy the wrong gate, and retyping on the way
 * in is cheaper than finding it later.
 *
 * The queue itself is the shared hook the sidebar badge counts, so the number on the
 * rail and the rows here can never disagree. The shipment, load and carrier names are
 * not on the document row, so each distinct shipment's bundle is read once and cached
 * for as long as the page is open — a poll that returns the same rows costs nothing.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ExternalLink, Eye, FileCheck2, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getShipmentBundle, getShipmentDocumentUrl, reviewDocument } from '@/lib/apiClient'
import { CARRIER_UPLOADABLE_TYPES, DOCUMENT_TYPE_LABELS } from '@/lib/shipmentDocuments'
import { formatDateTime } from '@/lib/date'
import { useDocumentReviewQueue } from '@/hooks/useDocumentReviewQueue'
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

export function DocumentReviewPage() {
  const navigate = useNavigate()
  const queue = useDocumentReviewQueue()

  const [context, setContext] = useState<Record<string, ShipmentContext>>({})
  const [preview, setPreview] = useState<{ doc: ShipmentDocumentRecord; url: string | null } | null>(null)
  const [accepting, setAccepting] = useState<ShipmentDocumentRecord | null>(null)
  const [acceptType, setAcceptType] = useState<ShipmentDocumentType>('POD')
  const [rejecting, setRejecting] = useState<ShipmentDocumentRecord | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // A primitive the effect can depend on; the document array is rebuilt by every poll.
  const shipmentIds = useMemo(
    () => Array.from(new Set(queue.documents.map((d) => d.shipmentId))).sort().join(','),
    [queue.documents],
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
      await queue.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record that decision')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <FileCheck2 size={18} />
        <h1 className="text-lg font-semibold">Documents</h1>
        <Badge variant="outline">{queue.pendingCount}</Badge>
        <Button
          variant="ghost" size="icon" className="ml-auto h-9 w-9" aria-label="Refresh"
          onClick={() => { void queue.refresh() }}
        >
          <RefreshCw size={14} className={queue.loading ? 'animate-spin' : undefined} />
        </Button>
      </header>

      <p className="border-b border-border px-5 py-2 text-xs text-muted-foreground">
        Files carriers sent through an upload link. Nothing here counts towards a required
        document until it is accepted, and accepting is where the type is confirmed.
      </p>

      {queue.error && <p className="px-5 py-3 text-sm text-destructive">{queue.error}</p>}

      <div className="flex-1 overflow-auto px-5 py-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-2">Received</th>
              <th className="px-2 py-2">Shipment · load</th>
              <th className="px-2 py-2">Carrier</th>
              <th className="px-2 py-2">Claimed type</th>
              <th className="px-2 py-2">File</th>
              <th className="px-2 py-2">Size</th>
              <th className="w-72" />
            </tr>
          </thead>
          <tbody>
            {queue.documents.length === 0 && !queue.loading && (
              <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">Nothing is waiting on review.</td></tr>
            )}
            {queue.documents.map((doc) => {
              const ctx = context[doc.shipmentId]
              const loadNumber = doc.loadId ? ctx?.loadNumbers[doc.loadId] : undefined
              const carrier = (doc.loadCarrierId ? ctx?.loadCarrierNames[doc.loadCarrierId] : undefined)
                ?? (doc.loadId ? ctx?.carrierNames[doc.loadId] : undefined)
              return (
                <tr key={doc.id} className="border-b border-border/60">
                  <td className="px-2 py-2 whitespace-nowrap">{formatDateTime(doc.uploadedAt)}</td>
                  <td className="px-2 py-2 font-medium">{loadNumber ?? ctx?.number ?? doc.shipmentId}</td>
                  <td className="px-2 py-2">{carrier ?? '—'}</td>
                  <td className="px-2 py-2">
                    <Badge variant="outline" className="text-[10px]">{DOCUMENT_TYPE_LABELS[doc.type]}</Badge>
                  </td>
                  <td className="max-w-xs truncate px-2 py-2">{doc.name}</td>
                  <td className="px-2 py-2 tabular-nums text-muted-foreground">{formatSize(doc.sizeBytes)}</td>
                  <td className="px-1 py-2">
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" size="sm" className="h-7" onClick={() => openPreview(doc)}>
                        <Eye size={13} className="mr-1" />Preview
                      </Button>
                      <Button size="sm" className="h-7" disabled={busy} onClick={() => startAccept(doc)}>
                        <Check size={13} className="mr-1" />Accept
                      </Button>
                      <Button
                        variant="outline" size="sm" className="h-7"
                        disabled={busy}
                        onClick={() => { setNote(''); setRejecting(doc) }}
                      >
                        <X size={13} className="mr-1" />Reject
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7" aria-label="Open shipment"
                        onClick={() => navigate(`/shipments/${doc.shipmentId}`)}
                      >
                        <ExternalLink size={13} />
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

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
        <Dialog open onOpenChange={(open) => { if (!open && !busy) setAccepting(null) }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Accept this document</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              {accepting.name} — the carrier filed this as {DOCUMENT_TYPE_LABELS[accepting.type]}. Confirm
              what it actually is; that is the type the shipment keeps.
            </p>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Document type
              <select
                aria-label="Confirmed document type"
                value={acceptType}
                onChange={(e) => setAcceptType(e.target.value as ShipmentDocumentType)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {CARRIER_UPLOADABLE_TYPES.map((t) => (
                  <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </Label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAccepting(null)} disabled={busy}>Cancel</Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void decide(
                    { documentId: accepting.id, decision: 'ACCEPT', type: acceptType },
                    'Document accepted',
                  )
                }}
              >
                {busy ? 'Saving…' : 'Accept'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {rejecting && (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) { setRejecting(null); setNote('') } }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Reject this document</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              {rejecting.name} — the note is what the carrier is told, so say what is wrong
              with it and what to send instead.
            </p>
            <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Why it is being rejected
              <Textarea
                aria-label="Rejection note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Page 2 is cut off — please re-send the whole POD"
                className="mt-1 text-sm"
              />
            </Label>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setRejecting(null); setNote('') }} disabled={busy}>Cancel</Button>
              <Button
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
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export default DocumentReviewPage
