import { Loader2, Package } from 'lucide-react'
import { usePodDocuments } from '@/hooks/usePodDocuments'
import { PodCard } from './PodCard'
import { PodPreviewDialog } from './PodPreviewDialog'
import type { PodDocument } from '@/types/pods'
import { useState } from 'react'

export function LoadPods({ loadId }: { loadId: string }) {
  const { status, statusLoading, statusError, docs, loading, error, refresh } = usePodDocuments({ loadId })
  const [previewDoc, setPreviewDoc] = useState<PodDocument | null>(null)

  if (statusLoading && !status) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2 py-2">
        <Loader2 size={14} className="animate-spin" /> Loading PODs…
      </div>
    )
  }

  if (statusError) {
    return (
      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
        {statusError}
      </div>
    )
  }

  if (!status?.configured) {
    return (
      <div className="text-sm text-muted-foreground py-2">
        JobsDone is not connected yet, so no PODs can be linked to this load. An admin can connect it from the PODs page.
      </div>
    )
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Package size={16} /> PODs
        </div>
        <button
          onClick={() => refresh()}
          disabled={loading}
          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="inline animate-spin mr-1" /> : null}
          Refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {loading && docs.length === 0 && (
        <div className="text-sm text-muted-foreground flex items-center gap-2 py-2">
          <Loader2 size={14} className="animate-spin" /> Loading PODs…
        </div>
      )}

      {docs.length === 0 && !loading && !error && (
        <div className="text-sm text-muted-foreground py-2">No PODs linked to this load.</div>
      )}

      {docs.length > 0 && (
        <div className="grid grid-cols-1 gap-3">
          {docs.map((doc) => (
            <PodCard key={doc.id} doc={doc} compact onPreview={setPreviewDoc} />
          ))}
        </div>
      )}

      {previewDoc && <PodPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}
