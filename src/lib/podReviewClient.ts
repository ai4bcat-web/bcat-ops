/**
 * Reads and writes for the PODs review queue. The rules live in ./podReview.ts.
 */
import { generateClient } from 'aws-amplify/data'
import { SUBMISSION_FIELDS, attachDocs, type DriverSubmissionRecord } from './driverSubmissionsClient'
import type { PodReviewChecks, PodReviewFields, PodReviewStatus, ReviewSubmission } from './podReview'

const client = generateClient()

/** Kept out of SUBMISSION_FIELDS so every other screen keeps working before this deploys. */
const REVIEW_FIELDS = `
  podReviewStatus podReviewNote podReviewedBy podReviewedAt podReviewChecks
  podReplacementRequestedAt podReplacementMessage
  podCheckStatus podCheck podCheckedAt podCheckError
`

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const result = (await client.graphql({ query, variables } as never)) as { data: T }
  return result.data
}

export async function listReviewSubmissions(): Promise<ReviewSubmission[]> {
  const items: (DriverSubmissionRecord & PodReviewFields)[] = []
  let nextToken: string | null = null
  do {
    const page: { listDriverSubmissions: { items: (DriverSubmissionRecord & PodReviewFields)[]; nextToken?: string | null } } =
      await gql(
        `query ListPodReview($limit: Int, $nextToken: String) {
          listDriverSubmissions(limit: $limit, nextToken: $nextToken) {
            items { ${SUBMISSION_FIELDS} ${REVIEW_FIELDS} }
            nextToken
          }
        }`,
        { limit: 1000, nextToken },
      )
    items.push(...page.listDriverSubmissions.items)
    nextToken = page.listDriverSubmissions.nextToken ?? null
  } while (nextToken)
  return (await attachDocs(items, 1000)) as ReviewSubmission[]
}

async function updateSubmission(input: Record<string, unknown>): Promise<ReviewSubmission> {
  const r = await gql<{ updateDriverSubmission: ReviewSubmission }>(
    `mutation UpdatePodReview($input: UpdateDriverSubmissionInput!) {
      updateDriverSubmission(input: $input) { ${SUBMISSION_FIELDS} ${REVIEW_FIELDS} }
    }`,
    { input: { ...input, updatedAt: new Date().toISOString() } },
  )
  return r.updateDriverSubmission
}

export async function saveReview(input: {
  id: string
  status: PodReviewStatus
  note: string
  checks: PodReviewChecks
  reviewer: string
}): Promise<ReviewSubmission> {
  return updateSubmission({
    id: input.id,
    podReviewStatus: input.status,
    podReviewNote: input.note.trim() || null,
    podReviewChecks: JSON.stringify(input.checks),
    podReviewedBy: input.status === 'PENDING' ? null : input.reviewer,
    podReviewedAt: input.status === 'PENDING' ? null : new Date().toISOString(),
  })
}

export async function recordReplacementRequest(input: {
  id: string
  note: string
  checks: PodReviewChecks
  reviewer: string
  message: string
}): Promise<ReviewSubmission> {
  const now = new Date().toISOString()
  return updateSubmission({
    id: input.id,
    podReviewStatus: 'NEEDS_REPLACEMENT',
    podReviewNote: input.note.trim() || null,
    podReviewChecks: JSON.stringify(input.checks),
    podReviewedBy: input.reviewer,
    podReviewedAt: now,
    podReplacementRequestedAt: now,
    podReplacementMessage: input.message,
  })
}
