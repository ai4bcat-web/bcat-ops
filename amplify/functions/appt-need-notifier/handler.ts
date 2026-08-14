/** The standing instruction posted whenever a stop is flagged NEED. */
const INSTRUCTION =
  'This shipment needs a pickup or delivery appt set. Please reach out to the appropriate ' +
  'contact to schedule an appt and update the thread and bcat-ops and e2open once complete.'

interface MutationArgs {
  /** Which stop was flagged — 'pickup' | 'delivery'. */
  stopKind: string
  /** Load identifiers, for a message someone can act on without opening the app. */
  aljexId?: string | null
  pickupNumber?: string | null
  customer?: string | null
  /** Where the stop is, when known. */
  location?: string | null
  /** The appointment date, already formatted for display. */
  apptDate?: string | null
  actorName?: string | null
}

interface AppSyncEvent {
  arguments: MutationArgs
  identity?: { claims?: { email?: string } }
}

/**
 * The reference line that lets a dispatcher find the load. Falls back through the
 * identifiers so the message is never just the bare instruction with no context.
 */
function referenceLine(a: MutationArgs): string {
  const parts = [
    a.aljexId ? `Pro# ${a.aljexId}` : null,
    a.pickupNumber ? `PU# ${a.pickupNumber}` : null,
    a.customer || null,
    a.location || null,
    a.apptDate || null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Load reference unavailable'
}

export const handler = async (event: AppSyncEvent) => {
  // Read at call time rather than module scope: the config guard below is then actually
  // reachable in tests, and Lambda env is static so there's nothing to gain by caching.
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
  const APPTS_IVAN_CHANNEL_ID = process.env.APPTS_IVAN_CHANNEL_ID

  const args = event.arguments
  const kind = args.stopKind === 'delivery' ? 'Delivery' : 'Pickup'

  if (!SLACK_BOT_TOKEN || !APPTS_IVAN_CHANNEL_ID) {
    console.warn('[appt-need-notifier] Slack not configured (token/channel) — skipping post')
    return { ok: false, error: 'not configured' }
  }

  const who = args.actorName || event.identity?.claims?.email || null
  const text = [
    `*${kind} appt needed* — ${referenceLine(args)}`,
    INSTRUCTION,
    who ? `_Flagged by ${who}_` : null,
  ].filter(Boolean).join('\n')

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: APPTS_IVAN_CHANNEL_ID, text }),
  })
  const json = await res.json() as { ok: boolean; error?: string; ts?: string }
  if (!json.ok) {
    console.error('[appt-need-notifier] chat.postMessage failed', json.error)
    return { ok: false, error: json.error ?? 'post failed' }
  }
  return { ok: true, ts: json.ts }
}
