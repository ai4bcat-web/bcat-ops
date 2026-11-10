/**
 * Load Review row action: look at the POD without opening the shipment (Ryne 2026-11-10). The reviewer's job includes the POD, so the
 * newest active POD document is one click away; a missing one says so, which is itself the answer to "does this need fixing".
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsButton, TmsDialog } from '@/features/tms/kit'
import { getShipmentDocumentUrl, listShipmentDocuments } from '@/lib/apiClient'
import { newestPod } from '@/lib/podPreview'
import type { ShipmentDocumentRecord } from '@/types/tms'

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ready'; doc: ShipmentDocumentRecord; url: string }

export function PodPreviewButton({ shipmentId, number }: { shipmentId: string; number: string | null }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>({ kind: 'idle' })

  const show = () => {
    setOpen(true)
    setState({ kind: 'loading' })
    listShipmentDocuments(shipmentId)
      .then(async (docs) => {
        const doc = newestPod(docs)
        if (!doc) return setState({ kind: 'none' })
        setState({ kind: 'ready', doc, url: await getShipmentDocumentUrl(doc.s3Key) })
      })
      .catch((e: unknown) => setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load the POD' }))
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
            <p className="tms-muted text-sm">{state.doc.name}{state.doc.source === 'DRIVER_APP' ? ' · from the driver app' : ''}</p>
            {state.doc.contentType.startsWith('image/')
              ? <img src={state.url} alt={`POD ${number ?? ''}`} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
              : <iframe title={`POD ${number ?? ''}`} src={state.url} style={{ width: '100%', height: '70vh', border: 0 }} />}
          </div>
        ) : null}
      </TmsDialog>
    </>
  )
}
