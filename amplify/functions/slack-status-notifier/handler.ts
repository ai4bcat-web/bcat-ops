import type { DynamoDBStreamEvent } from 'aws-lambda'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!

const STATUS_LABELS: Record<string, string> = {
  NEW:         'New',
  IN_PROGRESS: 'In Progress',
  BUILT:       'Load Built',
  DONE:        'Done',
  ARCHIVED:    'Archived',
}

async function postSlackReply(channel: string, threadTs: string, text: string) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
  const json = await res.json() as { ok: boolean; error?: string }
  if (!json.ok) {
    console.error('[slackStatusNotifier] chat.postMessage failed', json.error)
  }
}

export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY') continue
    if (!record.dynamodb?.NewImage || !record.dynamodb?.OldImage) continue

    const newImg = unmarshall(
      record.dynamodb.NewImage as Record<string, AttributeValue>
    )
    const oldImg = unmarshall(
      record.dynamodb.OldImage as Record<string, AttributeValue>
    )

    // Only act when status actually changed
    if (newImg.status === oldImg.status) continue

    // Only for Slack-sourced items that have thread context
    if (
      newImg.externalSource !== 'slack' ||
      !newImg.slackChannelId            ||
      !newImg.slackMessageTs
    ) continue

    const statusLabel = STATUS_LABELS[newImg.status as string] ?? newImg.status
    let text = `Status updated: *${statusLabel}*`
    if (newImg.builtLoadId) {
      text += `  •  Load ID: \`${newImg.builtLoadId}\``
    }

    await postSlackReply(
      newImg.slackChannelId as string,
      newImg.slackMessageTs as string,
      text,
    )
  }
}
