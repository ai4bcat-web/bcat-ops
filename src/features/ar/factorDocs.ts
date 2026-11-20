import type { OtrDocLink } from '@/lib/otrClient'

/** What the review found for one load: still looking, the two documents, or why it could not look. */
export type DocLook = { state: 'loading' } | { state: 'ready'; pod: OtrDocLink | null; rateCon: OtrDocLink | null } | { state: 'error'; message: string }

/** A document the review positively found missing: that load is left out of the send. */
export const missingDocs = (look: DocLook | undefined): string[] =>
  look?.state === 'ready' ? [...(look.rateCon ? [] : ['Rate confirmation']), ...(look.pod ? [] : ['POD'])] : []
