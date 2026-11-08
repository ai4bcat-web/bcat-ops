import { generateClient } from 'aws-amplify/data'
import { graphqlErrorText } from '@/lib/apiClient'
import { cachedList, invalidateLists, SUBMISSION_CACHE_PREFIX } from '@/lib/listCache'
import type { PodConnectionStatus, PodDocument, PodPage, PodAssets, PodSenderMapping } from '@/types/pods'

const client = generateClient()

/**
 * AppSync AWSJSON columns can arrive as a parsed object, a JSON string, or even a
 * double-encoded JSON string depending on the resolver and the generated client version.
 * Strip the string layers until we hit the real value.
 */
function unwrapJson(raw: unknown): unknown {
  let v = raw
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  return v
}

/**
 * `managePods` is a mutation field, so every call looks like a write to the cache layer; these
 * actions only read. Anything else clears the pod lists and the driver submission/document lists
 * the scan and assign actions change.
 */
const READ_ACTIONS = new Set(['status', 'list', 'assets', 'senderMappings'])
export const POD_CACHE_PREFIX = 'pods:'
const POD_CACHE = { ttlMs: 15_000 }

/**
 * A failed list is remembered for the same window as a good one (listCache never stores a rejection): while the POD connection is
 * unconfigured or down, every mounted paperwork/pay hook would otherwise re-issue the failing request (dev: 4 per page). A pod write
 * (configure included) clears it with the lists.
 */
const listFailures = new Map<string, { error: unknown; at: number }>()

async function podAction<T>(action: string, input: unknown): Promise<T> {
  if (READ_ACTIONS.has(action)) return runPodAction<T>(action, input)
  try {
    return await runPodAction<T>(action, input)
  } finally {
    listFailures.clear()
    invalidateLists(POD_CACHE_PREFIX)
    invalidateLists(SUBMISSION_CACHE_PREFIX)
  }
}

async function runPodAction<T>(action: string, input: unknown): Promise<T> {
  let r: { data: { managePods: unknown } }
  try {
    r = await client.graphql({
      query: `mutation ManagePods($action: String!, $input: AWSJSON) { managePods(action: $action, input: $input) }`,
      variables: { action, input: input != null ? JSON.stringify(input) : null },
    }) as { data: { managePods: unknown } }
  } catch (err) {
    throw new Error(graphqlErrorText(err) || `${action} failed`, { cause: err })
  }

  const v = unwrapJson(r.data.managePods)
  if (v == null) throw new Error(`${action} returned no result`)
  return v as T
}

export async function getPodConnectionStatus(): Promise<PodConnectionStatus> {
  return podAction<PodConnectionStatus>('status', {})
}

export async function configurePods(input: { apiKey: string; clientId: string }): Promise<PodConnectionStatus> {
  return podAction<PodConnectionStatus>('configure', input)
}

/** One request per page inside the window: the paperwork hooks on a page each list the same pods. */
export function listPods(input?: { loadId?: string; nextToken?: string | null }): Promise<PodPage> {
  const key = `${POD_CACHE_PREFIX}list:${input?.loadId ?? ''}|${input?.nextToken ?? ''}`
  const failed = listFailures.get(key)
  if (failed && Date.now() - failed.at < POD_CACHE.ttlMs) return Promise.reject(failed.error)
  return cachedList(key, () => podAction<PodPage>('list', { ...(input ?? {}) }), POD_CACHE).catch((error: unknown) => {
    listFailures.set(key, { error, at: Date.now() })
    throw error
  })
}

export async function backfillPods(): Promise<{ queued: true }> {
  return podAction<{ queued: true }>('backfill', {})
}

export async function getPodAssets(id: string): Promise<PodAssets> {
  return podAction<PodAssets>('assets', { id })
}

/**
 * Run the POD scan cleanup over a driver or staff upload.
 *
 * Fire-and-forget by design: the document is already saved and the original is intact, so a
 * failed cleanup must never surface as a failed upload. The row records what happened.
 */
export async function enhanceDriverDoc(docId: string): Promise<void> {
  try {
    await podAction<{ id: string; scanStatus: string }>('enhanceDriverDoc', { id: docId })
  } catch (err) {
    console.warn('[pods] could not enhance the uploaded document', docId, err)
  }
}

/**
 * Merge a submission's pages into one enhanced PDF, after they have been cleaned.
 *
 * Order matters: cleaning works on images, so merging has to come second. Doing it first —
 * which is what the browser used to do — handed the enhancer a PDF and it correctly found
 * nothing to clean.
 */
export async function finalizeDriverDocs(submissionId: string, kind: 'POD' | 'RATECON'): Promise<void> {
  try {
    await podAction<{ submissionId: string; pages: number }>('finalizeDriverDocs', { submissionId, kind })
  } catch (err) {
    console.warn('[pods] could not combine the uploaded pages', submissionId, err)
  }
}

/**
 * Hand the whole cleanup off and return.
 *
 * Cleaning a page is OCR plus image work and takes seconds; merging waits on all of them.
 * Running that inside the upload meant whoever uploaded sat watching a spinner for the
 * length of the pipeline, having already done their part. This call only queues it: the
 * Lambda invokes itself and answers straight away.
 *
 * Nothing is lost by not waiting. The pages are in S3 and readable the moment they land,
 * and every reader falls back to the original until a cleaned copy exists.
 */
/** Re-read a merged driver POD against its rate confirmation. Queued; the result lands on the submission. */
export async function queueDriverPodCheck(submissionId: string): Promise<{ queued: boolean; error?: string }> {
  return podAction<{ queued: boolean; error?: string }>('checkDriverPod', { submissionId })
}

export async function queueDriverDocScan(submissionId: string, kind: 'POD' | 'RATECON'): Promise<void> {
  try {
    await podAction<{ queued: boolean }>('queueDriverDocScan', { submissionId, kind })
  } catch (err) {
    // A cleanup that could not be queued is a document that stays as it arrived, which is
    // exactly what used to happen to every PDF. Never a failed upload.
    console.warn('[pods] could not queue the scan cleanup', submissionId, err)
  }
}

export async function assignPod(args: { id: string; loadId: string | null; expectedVersion: number }): Promise<{ item: PodDocument }> {
  return podAction<{ item: PodDocument }>('assign', args)
}

export async function retryPod(args: { id: string }): Promise<{ item: PodDocument }> {
  return podAction<{ item: PodDocument }>('retry', args)
}

export async function getPodSenderMappings(): Promise<{ items: PodSenderMapping[] }> {
  return podAction<{ items: PodSenderMapping[] }>('senderMappings', {})
}

export async function setPodSenderMapping(input: { phone: string; senderName: string; driverId: string | null }): Promise<{ item?: PodSenderMapping; deleted?: boolean; senderKey?: string }> {
  return podAction<{ item?: PodSenderMapping; deleted?: boolean; senderKey?: string }>('setSenderMapping', input)
}
