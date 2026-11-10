/**
 * Load Review row action: look at the POD without opening the shipment (Ryne 2026-11-10). The reviewer's job includes the POD, so the
 * newest active POD document is one click away; a missing one says so, which is itself the answer to "does this need fixing".
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { getShipmentDocumentUrl, listShipmentDocuments, reviewDocument } from '@/lib/apiClient'
import { toast } from 'sonner'
import { activePods } from '@/lib/podPreview'
import type { ShipmentDocumentRecord } from '@/types/tms'

type Page = { doc: ShipmentDocumentRecord; url: string }
type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ready'; pages: Page[] }

export function PodPreviewButton({ shipmentId, number }: { shipmentId: string; number: string | null }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>({ kind: 'idle' })

  const load = () => {
    setState({ kind: 'loading' })
    listShipmentDocuments(shipmentId)
      .then(async (docs) => {
        const pods = activePods(docs)
        if (pods.length === 0) return setState({ kind: 'none' })
        setState({ kind: 'ready', pages: await Promise.all(pods.map(async (doc) => ({ doc, url: await getShipmentDocumentUrl(doc.s3Key) }))) })
      })
      .catch((e: unknown) => setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load the POD' }))
  }
  const show = () => { setOpen(true); load() }
  // A driver-filed page waits for a reviewer; accepting here is what makes it the POD.
  const decide = (decision: 'ACCEPT' | 'REJECT', pages: Page[]) => {
    const waiting = pages.filter((p) => p.doc.reviewStatus === 'PENDING')
    Promise.all(waiting.map((p) => reviewDocument({ documentId: p.doc.id, decision })))
      .then(() => { toast.success(decision === 'ACCEPT' ? 'POD accepted' : 'POD refused'); load() })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not save the review'))
  }

  return (
    <>
      <TmsButton size="sm" variant="ghost" data-testid={`pod-preview-${shipmentId}`} onClick={(e) => { e.stopPropagation(); show() }}>POD</TmsButton>
      <TmsDialog open={open} onOpenChange={setOpen} className="tms-dialog-wide" title={`POD${number ? ` · ${number}` : ''}`}>
        {state.kind === 'loading' ? <p className="tms-muted">Loading the POD…</p> : null}
        {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}
        {state.kind === 'none' ? (
          <p data-testid="pod-none">No POD is on file for this shipment. <Link to={`/tms/shipments/${shipmentId}/edit`}>Open the shipment</Link> to add one.</p>
        ) : null}
        {state.kind === 'ready' ? (
          <div data-testid="pod-ready">
            {state.pages.some((p) => p.doc.reviewStatus === 'PENDING') ? (
              <p className="flex items-center gap-2" data-testid="pod-pending">
                <span>Filed from the driver app, waiting for review.</span>
                <TmsButton size="sm" variant="primary" data-testid="pod-accept" onClick={() => decide('ACCEPT', state.pages)}>Accept POD</TmsButton>
                <TmsButton size="sm" variant="ghost" data-testid="pod-refuse" onClick={() => decide('REJECT', state.pages)}>Refuse</TmsButton>
              </p>
            ) : null}
            {state.pages.map(({ doc, url }) => (
              <div key={doc.id}>
                <p className="tms-muted text-sm">{doc.name}{doc.source === 'DRIVER_APP' ? ' · from the driver app' : ''}</p>
                {doc.contentType.startsWith('image/')
                  ? <img src={url} alt={doc.name} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
                  : <iframe title={doc.name} src={url} style={{ width: '100%', height: '70vh', border: 0 }} />}
              </div>
            ))}
          </div>
        ) : null}
      </TmsDialog>
    </>
  )
}
