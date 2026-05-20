import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'

const dynamo          = new DynamoDBClient({})
const TABLE_NAME      = process.env.TABLE_NAME!
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!

const STATUS_LABELS: Record<string, string> = {
  NEW:         'New',
  IN_PROGRESS: 'In Progress',
  BUILT:       'Load Built',
  DONE:        'Done',
  ARCHIVED:    'Archived',
}

interface MutationArgs {
  intakeItemId: string
  oldStatus?: string | null
  newStatus: string
  actorName?: string | null
  proNumber?: string | null      // BCAT DONE message: Pro# built in Aljex
  reassignedTo?: string | null   // reassignment reply: display name of new assignee
}

// AppSync Lambda direct resolver event shape
interface AppSyncEvent {
  arguments: MutationArgs
  identity?: { claims?: { email?: string } }
}

async function postSlackReply(channel: string, threadTs: string, text: string) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
  const json = await res.json() as { ok: boolean; error?: string }
  if (!json.ok) {
    console.error('[slackStatusNotifier] chat.postMessage failed', json.error)
  }
}

export const handler = async (event: AppSyncEvent) => {
  const { intakeItemId, oldStatus, newStatus, actorName, proNumber, reassignedTo } = event.arguments

  // Fetch the item to get Slack thread context
  const result = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { id: { S: intakeItemId } },
  }))

  if (!result.Item) {
    console.warn('[slackStatusNotifier] item not found', intakeItemId)
    return { ok: false, error: 'Item not found' }
  }

  const item = unmarshall(result.Item)

  // Only notify for Slack-sourced items with thread context
  if (item.externalSource !== 'slack' || !item.slackChannelId || !item.slackMessageTs) {
    return { ok: true, skipped: true }
  }

  let text: string

  if (reassignedTo) {
    // Reassignment message — status is unchanged
    const actor = actorName ?? 'Someone'
    text = `👤 ${actor} reassigned this to *${reassignedTo}*`
  } else {
    // Status-change message
    switch (newStatus) {
      case 'IN_PROGRESS':
        text = `🔄 ${actorName ?? 'Someone'} is working on this`
        break
      case 'BUILT': {
        const proRef = proNumber ? `  •  Pro# \`${proNumber}\`` : (item.builtLoadId ? `  •  Load ID: \`${item.builtLoadId}\`` : '')
        text = `✅ ${actorName ?? 'Someone'} built this load in BCAT Ops${proRef}`
        break
      }
      case 'DONE': {
        const proRef = proNumber ? `  •  Pro# \`${proNumber}\`` : ''
        text = `✅ ${actorName ?? 'Someone'} marked this done — built in Aljex${proRef}`
        break
      }
      case 'ARCHIVED':
        text = `🗄️ ${actorName ?? 'Someone'} archived this`
        break
      default: {
        const newLabel = STATUS_LABELS[newStatus] ?? newStatus
        const oldLabel = oldStatus ? (STATUS_LABELS[oldStatus] ?? oldStatus) : null
        text = `Status updated: *${newLabel}*`
        if (oldLabel) text += `  (was: ${oldLabel})`
        if (actorName) text += `  •  by ${actorName}`
      }
    }
  }

  await postSlackReply(item.slackChannelId as string, item.slackMessageTs as string, text)

  return { ok: true }
}
