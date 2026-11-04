import { generateClient } from 'aws-amplify/data'
import { uploadData, getUrl } from 'aws-amplify/storage'
import type { FeedbackItem, FeedbackStatus } from '@/features/feedback/feedbackLogic'

const client = generateClient()

const FIELDS = 'id page summary details screenshotKeys status submittedBy submittedByName adminNotes resolvedAt createdAt updatedAt'

export async function listFeedback(): Promise<FeedbackItem[]> {
  const out: FeedbackItem[] = []
  let nextToken: string | null = null
  do {
    const r = (await client.graphql({
      query: `query ListFeedbacks($nextToken: String) { listFeedbacks(limit: 1000, nextToken: $nextToken) { items { ${FIELDS} } nextToken } }`,
      variables: { nextToken },
    })) as { data: { listFeedbacks: { items: FeedbackItem[]; nextToken?: string | null } } }
    out.push(...r.data.listFeedbacks.items)
    nextToken = r.data.listFeedbacks.nextToken ?? null
  } while (nextToken)
  return out
}

export async function createFeedback(input: {
  page: string
  summary: string
  details?: string
  submittedBy: string
  submittedByName: string
}): Promise<FeedbackItem> {
  const r = (await client.graphql({
    query: `mutation CreateFeedback($input: CreateFeedbackInput!) { createFeedback(input: $input) { ${FIELDS} } }`,
    variables: { input: { ...input, details: input.details || null, status: 'NEW', screenshotKeys: [] } },
  })) as { data: { createFeedback: FeedbackItem } }
  return r.data.createFeedback
}

export async function updateFeedback(
  id: string,
  patch: { screenshotKeys?: string[]; status?: FeedbackStatus; resolvedAt?: string | null; adminNotes?: string },
): Promise<FeedbackItem> {
  const r = (await client.graphql({
    query: `mutation UpdateFeedback($input: UpdateFeedbackInput!) { updateFeedback(input: $input) { ${FIELDS} } }`,
    variables: { input: { id, ...patch } },
  })) as { data: { updateFeedback: FeedbackItem } }
  return r.data.updateFeedback
}

export async function uploadFeedbackScreenshot(feedbackId: string, file: File, index: number): Promise<string> {
  const safeName = (file.name || 'screenshot.png').replace(/[^\w.-]+/g, '_')
  const key = `feedback/${feedbackId}/${Date.now()}-${index}-${safeName}`
  await uploadData({ path: key, data: file, options: { contentType: file.type || 'image/png' } }).result
  return key
}

export async function getFeedbackScreenshotUrl(key: string): Promise<string> {
  const r = await getUrl({ path: key, options: { expiresIn: 3600 } })
  return r.url.toString()
}
