/** The two documents OTR receives, shown as the files themselves; shared by every Factor review. */
import { Loader2 } from 'lucide-react'
import { TmsBadge } from '@/features/tms/kit'
import type { OtrDocLink } from '@/lib/otrClient'
import type { DocLook } from '../factorDocs'

/** One document of the pair OTR receives, shown as the file itself. */
export function DocPane({ title, look, pick }: {
  title: string
  look: DocLook | undefined
  pick: (look: Extract<DocLook, { state: 'ready' }>) => OtrDocLink | null
}) {
  const doc = look?.state === 'ready' ? pick(look) : null
  return (
    <section className="send-review-col" aria-label={title}>
      <div className="flex items-center gap-2 text-sm">
        <strong>{title}</strong>
        {look?.state === 'ready' && (doc ? <TmsBadge tone="green">On file</TmsBadge> : <TmsBadge tone="red">Missing</TmsBadge>)}
        {doc && <span className="tms-muted truncate">{doc.name}</span>}
      </div>
      {(!look || look.state === 'loading') && <p className="flex items-center gap-2 text-sm tms-muted"><Loader2 size={14} className="animate-spin" /> Loading…</p>}
      {doc && <iframe title={`${title} preview`} src={doc.url} style={{ width: '100%', height: 560, border: '1px solid var(--tms-border)' }} />}
      {look?.state === 'ready' && !doc && <p className="text-sm tms-muted">Nothing on file to send.</p>}
    </section>
  )
}
