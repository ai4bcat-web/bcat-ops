import { generateClient } from 'aws-amplify/data'
import { graphqlErrorText } from '@/lib/apiClient'
import type { PodConnectionStatus, PodDocument, PodPage, PodAssets } from '@/types/pods'

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

async function podAction<T>(action: string, input: unknown): Promise<T> {
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

export async function listPods(input?: { loadId?: string; nextToken?: string | null }): Promise<PodPage> {
  return podAction<PodPage>('list', { ...(input ?? {}) })
}

export async function backfillPods(): Promise<{ queued: true }> {
  return podAction<{ queued: true }>('backfill', {})
}

export async function getPodAssets(id: string): Promise<PodAssets> {
  return podAction<PodAssets>('assets', { id })
}

export async function assignPod(args: { id: string; loadId: string | null; expectedVersion: number }): Promise<{ item: PodDocument }> {
  return podAction<{ item: PodDocument }>('assign', args)
}

export async function retryPod(args: { id: string }): Promise<{ item: PodDocument }> {
  return podAction<{ item: PodDocument }>('retry', args)
}
