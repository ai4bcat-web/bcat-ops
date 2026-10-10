/**
 * dispatch-nudge Lambda — see resource.ts and _shared/dispatchNudge.ts.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DispatchStore, tablesFromEnv } from '../_shared/dispatchStore'
import { slackClient, type SlackClient } from '../_shared/slackApi'
import { nudgeFor } from '../_shared/dispatchNudge'

const dynamo = new DynamoDBClient({})
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''

export interface NudgeDeps {
  store: DispatchStore
  slack: SlackClient
  now: () => Date
}

/** DM a person by email. Slack opens the DM when posting to a user id. */
async function dm(slack: SlackClient, email: string, text: string): Promise<boolean> {
  try {
    const u = await slack.call<{ user: { id: string } }>('users.lookupByEmail', { email })
    await slack.call('chat.postMessage', { channel: u.user.id, text })
    return true
  } catch (err) {
    console.warn('[dispatch-nudge] could not DM', email, String(err))
    return false
  }
}

export async function runNudges(deps: NudgeDeps): Promise<{ sent: number; checked: number }> {
  const nowMs = deps.now().getTime()
  const [conversations, drivers] = await Promise.all([deps.store.listConversations(), deps.store.listDrivers()])
  let sent = 0
  for (const c of conversations) {
    const driver = c.driverId ? drivers.find((d) => d.id === c.driverId) ?? null : null
    const plan = nudgeFor(c, driver, nowMs)
    if (!plan) continue
    // Record first so a slow Slack call can never double-send on the next tick.
    await deps.store.updateConversation(c.id, { set: { nudgedFor: plan.forAt, nudgeStage: plan.stage } })
    if (await dm(deps.slack, plan.to, plan.text)) sent += 1
  }
  return { sent, checked: conversations.length }
}

export const handler = async () => {
  if (!SLACK_BOT_TOKEN) return { sent: 0, checked: 0, skipped: 'no slack token' }
  const result = await runNudges({ store: new DispatchStore(dynamo, tablesFromEnv()), slack: slackClient(SLACK_BOT_TOKEN), now: () => new Date() })
  console.log('[dispatch-nudge]', result)
  return result
}
