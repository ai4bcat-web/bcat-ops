import { generateClient } from 'aws-amplify/data'
import type { FeedbackItem, FeedbackStatus } from '@/features/feedback/feedbackLogic'
import { OPEN_QUESTION_PAGE } from '@/features/openQuestions/openQuestions'

const client = generateClient()

const FIELDS = 'id page summary details status adminNotes createdAt updatedAt'

/** Every Accounting open question (Feedback rows with page = OPEN_QUESTION_PAGE). */
export async function listOpenQuestionRows(): Promise<FeedbackItem[]> {
  const out: FeedbackItem[] = []
  let nextToken: string | null = null
  do {
    const r = (await client.graphql({
      query: `query ListOpenQuestions($filter: ModelFeedbackFilterInput, $nextToken: String) { listFeedbacks(filter: $filter, limit: 1000, nextToken: $nextToken) { items { ${FIELDS} } nextToken } }`,
      variables: { filter: { page: { eq: OPEN_QUESTION_PAGE } }, nextToken },
    })) as { data: { listFeedbacks: { items: FeedbackItem[]; nextToken?: string | null } } }
    out.push(...r.data.listFeedbacks.items)
    nextToken = r.data.listFeedbacks.nextToken ?? null
  } while (nextToken)
  return out
}

export async function updateOpenQuestionRow(
  id: string,
  patch: { status?: FeedbackStatus; adminNotes?: string },
): Promise<FeedbackItem> {
  const r = (await client.graphql({
    query: `mutation UpdateOpenQuestion($input: UpdateFeedbackInput!) { updateFeedback(input: $input) { ${FIELDS} } }`,
    variables: { input: { id, ...patch } },
  })) as { data: { updateFeedback: FeedbackItem } }
  return r.data.updateFeedback
}
