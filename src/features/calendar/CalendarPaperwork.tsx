/**
 * POD status on the calendar, with a preview — the same index and the same viewer the
 * loads board uses, so a tick here and a tick there can never disagree.
 *
 * A context rather than a prop threaded through three views: the planner, the week/month
 * grid and every card in them read one index built once per page from the POD stores.
 * Outside the provider (tests, other pages) the mark reads "unknown" and never "missing".
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useLoadPaperwork, paperworkFor, type PaperworkCell } from '@/hooks/useLoadPaperwork'
import { resolveDoc } from '@/lib/openPaperwork'
import { DocumentPreview } from '@/features/documents/DocumentPreview'
import type { PodIndex } from '@/lib/podPresence'
import type { Load } from '@/types'

interface CalendarPaperworkValue {
  index: PodIndex | null
  openPod: (load: Load, cell: PaperworkCell) => void
}

const CalendarPaperworkContext = createContext<CalendarPaperworkValue>({ index: null, openPod: () => {} })

export function CalendarPaperworkProvider({ loads, children }: { loads: Load[]; children: ReactNode }) {
  const paperwork = useLoadPaperwork(loads)
  const [preview, setPreview] = useState<{ title: string; subtitle: string; name: string; url: string; contentType: string | null | undefined } | null>(null)

  // The URL is minted on the click, never cached: presigned links expire, and a calendar
  // left open all morning would hand out ones S3 has stopped honouring.
  const openPod = useCallback(async (load: Load, cell: PaperworkCell) => {
    if (!cell.ref) return
    try {
      const name = `POD-${load.aljexId || load.id.slice(-6)}`
      const doc = await resolveDoc(cell.ref, name)
      setPreview({
        title: `POD · PRO ${load.aljexId || '—'}`,
        subtitle: [load.customer ?? '', load.originCity && load.destinationCity ? `${load.originCity} → ${load.destinationCity}` : '']
          .filter(Boolean).join(' · '),
        name, url: doc.url, contentType: doc.contentType,
      })
    } catch (err) {
      toast.error(`Couldn't open the POD: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }, [])

  const value = useMemo(() => ({ index: paperwork.index, openPod: (l: Load, c: PaperworkCell) => void openPod(l, c) }), [paperwork.index, openPod])

  return (
    <CalendarPaperworkContext.Provider value={value}>
      {children}
      {preview && (
        <DocumentPreview
          open
          onClose={() => setPreview(null)}
          title={preview.title}
          subtitle={preview.subtitle}
          url={preview.url}
          contentType={preview.contentType}
          downloadName={preview.name}
        />
      )}
    </CalendarPaperworkContext.Provider>
  )
}

/**
 * The POD mark for one delivery: green tick (with a page count), red cross, or a dash
 * while the stores are still being read. Click opens the document; the click never
 * reaches the row, so it does not also open the load.
 */
export function PodMark({ load, size = 14 }: { load: Load; size?: number }) {
  const { index, openPod } = useContext(CalendarPaperworkContext)
  const cell = paperworkFor(index, load).pod
  if (cell.has === null) {
    return <span aria-label="POD: still loading" title="POD: still loading" style={{ color: 'var(--ds-t3)', fontSize: 11 }}>—</span>
  }
  if (!cell.has) {
    return <XCircle aria-label="POD missing" style={{ width: size, height: size, color: '#dc2626', flexShrink: 0 }} />
  }
  const pages = cell.pages && cell.pages > 1 ? ` · ${cell.pages} pages` : ''
  const label = `POD on file${pages}${cell.ref ? ' — click to view' : ''}`
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!cell.ref}
      onClick={(e) => { e.stopPropagation(); openPod(load, cell) }}
      style={{ all: 'unset', cursor: cell.ref ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 2, lineHeight: 1 }}
    >
      <CheckCircle2 style={{ width: size, height: size, color: '#16a34a', flexShrink: 0 }} />
      {cell.pages && cell.pages > 1 ? (
        <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>{cell.pages}p</span>
      ) : null}
    </button>
  )
}
