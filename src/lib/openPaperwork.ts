/**
 * Turn a document reference into something a preview can open.
 *
 * The loads grid says whether a load has its paperwork; this is what lets someone act on
 * that answer without leaving the row. Two stores, reached two different ways, and the
 * difference is not cosmetic:
 *
 *  - `s3` — `rate-confirms/…` and `driver-docs/…`. The browser holds credentials for both
 *    prefixes and presigns them itself.
 *  - `podDocument` — a JobsDone POD under `pods/…`, a prefix deliberately absent from the
 *    storage rules, so no browser credential can read it. It is presigned server-side by
 *    the pod-actions Lambda and reached by id.
 *
 * Both come back as the same small shape, so a caller never has to care which it was.
 */
import { getUrl } from 'aws-amplify/storage'
import { getPodAssets } from './podsClient'
import type { DocRef } from './podPresence'

export interface OpenableDoc {
  url: string
  /** Signed to arrive as a download, when the store offers one. */
  downloadUrl?: string
  contentType?: string | null
  fileName: string
}

/** Presigned URLs are short-lived, so this is called at the moment of opening, never cached. */
export async function resolveDoc(ref: DocRef, fallbackName: string): Promise<OpenableDoc> {
  if (ref.kind === 's3') {
    const res = await getUrl({ path: ref.key, options: { expiresIn: 900 } })
    const name = ref.key.split('/').pop() || fallbackName
    return { url: res.url.toString(), fileName: name }
  }

  const assets = await getPodAssets(ref.id)
  /*
   * The cleaned scan is what anyone should open or send on — it is the copy that goes to a
   * broker — but a POD that failed cleanup still has to be readable, so the original is the
   * fallback rather than an error.
   */
  const url = assets.enhancedUrl ?? assets.originalUrl
  if (!url) throw new Error('That POD has no readable file on it yet')
  const a = assets as { enhancedDownloadUrl?: string; originalDownloadUrl?: string }
  return {
    url,
    downloadUrl: assets.enhancedUrl ? a.enhancedDownloadUrl : a.originalDownloadUrl,
    contentType: assets.enhancedUrl ? 'image/jpeg' : assets.item?.contentType ?? null,
    fileName: assets.item?.fileName || fallbackName,
  }
}
