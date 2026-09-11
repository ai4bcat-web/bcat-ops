/**
 * carrier-blast-api Lambda
 *
 * AppSync custom mutation handler and EventBridge cron target for the Instantly-backed
 * Carriers email-blast feature. Dispatches on `event.arguments.action` (AppSync) or
 * `event.action` (EventBridge).
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import {
  listAccounts,
  createCampaign,
  addLeads,
  chunkLeads,
  activateCampaign,
  pauseCampaign,
  campaignAnalytics,
  listReceivedEmails,
  replyToEmail,
  listWebhooks,
  createWebhook,
  accountDailySends,
  type InstantlyAccount,
  type InstantlyEmail,
} from './instantly'
import { fetchJobsDoneClients } from './jobsdone'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const lambda = new LambdaClient({})

const getContactTable = () => process.env.CONTACT_TABLE!
const getCampaignTable = () => process.env.CAMPAIGN_TABLE!
const getReplyTable = () => process.env.REPLY_TABLE!
const getWebhookUrl = () => process.env.WEBHOOK_URL!
const getWebhookSecret = () => process.env.INSTANTLY_WEBHOOK_SECRET!

export type Lane = 'IL_IA' | 'IL_WI'

export type CarrierContact = {
  id: string
  __typename: 'CarrierContact'
  lane: Lane
  email: string
  firstName?: string
  lastName?: string
  company?: string
  status: 'active' | 'bounced' | 'unsubscribed' | 'removed'
  source?: string
  addedBy?: string
  addedAt: string
  lastCampaignId?: string
  lastSentAt?: string
  notes?: string
}

export type CarrierCampaign = {
  id: string
  __typename: 'CarrierCampaign'
  lane: Lane
  name: string
  subject: string
  bodyHtml: string
  instantlyCampaignId?: string
  senderAccounts: string[]
  dailyLimit?: number
  status: 'draft' | 'pushing' | 'sending' | 'paused' | 'completed' | 'failed'
  leadCount: number
  pushedCount: number
  errorText?: string
  sentCount: number
  openCount: number
  replyCount: number
  bounceCount: number
  unsubscribeCount: number
  analyticsAt?: string
  createdBy?: string
  startedAt?: string
  completedAt?: string
}

export type CarrierReply = {
  id: string
  __typename: 'CarrierReply'
  instantlyEmailId: string
  instantlyCampaignId?: string
  campaignId?: string
  lane?: Lane
  contactId?: string
  fromEmail: string
  fromName?: string
  toAccount: string
  subject: string
  textBody?: string
  htmlBody?: string
  snippet?: string
  threadId?: string
  receivedAt: string
  isAutoReply: boolean
  status: 'open' | 'handled'
  assignedTo?: string
  handledBy?: string
  handledAt?: string
  uniboxUrl?: string
  lastOutboundAt?: string
}

type AppSyncEvent = {
  arguments: { action: string; payload?: unknown }
  identity?: { claims?: { email?: string } }
}

type CronEvent = { action: 'cron' }

export function makeReplyId(emailId: string): string {
  return `instantly:${emailId}`
}

export function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
}

export function daysToReach(activeCount: number, dailyCapacity: number): number | null {
  if (!dailyCapacity || dailyCapacity <= 0 || activeCount <= 0) return null
  return Math.ceil(activeCount / dailyCapacity)
}

/**
 * Sending-mailbox policy.
 *
 * These mailboxes are SHARED with the JobsDone OS outbound engine, which sends from them
 * every day. Instantly's per-account `daily_limit` is consumed across ALL campaigns in the
 * workspace, so an unbounded carrier blast would eat the engine's allowance and silently
 * starve it (and stack more volume on domains that already tripped Bounce Protect once).
 *
 * Measured JobsDone usage: peak 21–24 sends/day/mailbox against a 40/day limit. So we
 * reserve 25/day/mailbox for the engine and let carrier blasts use only what is left.
 */
export const SENDER_ALLOWLIST = /jobsdone/i
/**
 * Hard denylist — these mailboxes may NEVER send a carrier blast, under any setting.
 *
 * The cowtown domains are a separate freight brand in the same Instantly workspace and
 * several are already in an error state (status -3). sidekickmlo is unrelated. This is a
 * belt-and-braces check: the allowlist above would already exclude them, but the denylist
 * means loosening the allowlist later still cannot leak sends onto these domains. Checked
 * at every send path — mailbox selection, campaign launch, and replying to a carrier.
 */
export const SENDER_DENYLIST = /cowtown|haulcowtown|sidekickmlo/i

/** True when this mailbox is permitted to send carrier mail at all. */
export function senderAllowed(email: string): boolean {
  return SENDER_ALLOWLIST.test(email) && !SENDER_DENYLIST.test(email)
}

/** Per-mailbox sends/day held back for the JobsDone OS engine. Never encroach on this. */
export const JOBSDONE_RESERVE_PER_MAILBOX = 25
/** Default carrier-blast sends/day/mailbox — conservative, well under the leftover. */
export const DEFAULT_PER_MAILBOX_PER_DAY = 12

/** The most a carrier blast may take from one mailbox without touching the reserve. */
export function maxPerMailbox(account: Pick<InstantlyAccount, 'daily_limit'>): number {
  return Math.max(0, (account.daily_limit ?? 0) - JOBSDONE_RESERVE_PER_MAILBOX)
}

export function accountIsOk(account: InstantlyAccount): boolean {
  // Permitted domain; warmed, no errors, warmup score >= 90, and enough daily allowance
  // left over after the JobsDone OS reserve to send anything at all.
  return senderAllowed(account.email)
    && account.status === 1
    && account.warmup_status === 1
    && account.setup_pending === false
    && (account.stat_warmup_score ?? 0) >= 90
    && maxPerMailbox(account) > 0
}

export function normalizeAccount(account: InstantlyAccount) {
  return {
    email: account.email,
    status: account.status,
    warmupStatus: account.warmup_status,
    dailyLimit: account.daily_limit ?? 0,
    warmupScore: account.stat_warmup_score ?? 0,
    provider: account.provider_code,
    ok: accountIsOk(account),
  }
}

export type CapacityInputAccount = {
  email: string
  dailyLimit: number
}

export type CapacityOptions = {
  accounts: CapacityInputAccount[]
  sentToday: Record<string, number>
  reservePerMailbox: number
  sharedClientsActive: number
  jobsDoneReachable: boolean
  claimedMailboxes: string[]
}

export type CapacityResult = {
  mailboxes: number
  perMailboxLimit: number
  sentToday: number
  reservedForJobsDone: number
  availableToday: number
  perMailbox: Array<{
    email: string
    dailyLimit: number
    sentToday: number
    reserved: number
    available: number
  }>
}

/**
 * Pure capacity arithmetic shared by the capacity action and the launch path.
 *
 * Reserve is held when:
 *   - JobsDone OS is unreachable (fail-safe), OR
 *   - at least one ACTIVE SHARED JobsDone client exists, OR
 *   - the mailbox is claimed by any client via non-empty instantlyMailboxes.
 */
export function computeCapacity(options: CapacityOptions): CapacityResult {
  const {
    accounts,
    sentToday,
    reservePerMailbox,
    sharedClientsActive,
    jobsDoneReachable,
    claimedMailboxes,
  } = options
  const claimed = new Set(claimedMailboxes.map((e) => e.toLowerCase()))

  const perMailbox = accounts.map((a) => {
    const email = a.email.toLowerCase()
    const dailyLimit = a.dailyLimit
    const sent = sentToday[email] ?? 0
    const reserve =
      !jobsDoneReachable || sharedClientsActive > 0 || claimed.has(email)
        ? reservePerMailbox
        : 0
    const available = Math.max(0, dailyLimit - sent - reserve)
    return { email, dailyLimit, sentToday: sent, reserved: reserve, available }
  })

  const sentTotal = perMailbox.reduce((sum, m) => sum + m.sentToday, 0)
  const reservedTotal = perMailbox.reduce((sum, m) => sum + m.reserved, 0)
  const availableToday = perMailbox.reduce((sum, m) => sum + m.available, 0)
  const perMailboxLimit =
    accounts.length > 0 ? Math.max(0, ...accounts.map((a) => a.dailyLimit)) : 0

  return {
    mailboxes: accounts.length,
    perMailboxLimit,
    sentToday: sentTotal,
    reservedForJobsDone: reservedTotal,
    availableToday,
    perMailbox,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export async function getCampaign(id: string): Promise<CarrierCampaign | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: getCampaignTable(), Key: { id } }),
  )
  return (res.Item as CarrierCampaign | undefined) ?? null
}

export async function getReply(id: string): Promise<CarrierReply | null> {
  const res = await ddb.send(new GetCommand({ TableName: getReplyTable(), Key: { id } }))
  return (res.Item as CarrierReply | undefined) ?? null
}

export async function updateCampaign(
  id: string,
  updates: Partial<CarrierCampaign>,
): Promise<void> {
  const keys = Object.keys(updates).filter((k) => k !== 'id' && updates[k as keyof CarrierCampaign] !== undefined)
  if (keys.length === 0) return
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}
  const sets: string[] = []
  keys.forEach((k, i) => {
    const nameKey = `#f${i}`
    const valKey = `:v${i}`
    names[nameKey] = k
    values[valKey] = updates[k as keyof CarrierCampaign]
    sets.push(`${nameKey} = ${valKey}`)
  })
  await ddb.send(
    new UpdateCommand({
      TableName: getCampaignTable(),
      Key: { id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  )
}

export async function scanAll<T>(tableName: string, filter?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> }): Promise<T[]> {
  const items: T[] = []
  let lastKey: Record<string, unknown> | undefined
  const names = filter?.names && Object.keys(filter.names).length > 0 ? filter.names : undefined
  const values = filter?.values && Object.keys(filter.values).length > 0 ? filter.values : undefined
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: filter?.expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: lastKey,
      }),
    )
    if (res.Items) items.push(...(res.Items as T[]))
    lastKey = res.LastEvaluatedKey
  } while (lastKey)
  return items
}

async function scanActiveContactsByLane(lane: Lane): Promise<CarrierContact[]> {
  const all = await scanAll<CarrierContact>(getContactTable(), {
    expression: '#lane = :lane AND #status = :status',
    names: { '#lane': 'lane', '#status': 'status' },
    values: { ':lane': lane, ':status': 'active' },
  })
  return all
}

export async function putReply(reply: CarrierReply): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: getReplyTable(),
      Item: reply,
      ConditionExpression: 'attribute_not_exists(id)',
    }),
  )
}

export async function loadCampaignMapByInstantlyId(): Promise<Record<string, { id: string; lane: Lane }>> {
  const campaigns = await scanAll<CarrierCampaign>(getCampaignTable(), {
    expression: 'attribute_exists(instantlyCampaignId)',
    names: {},
    values: {},
  })
  const map: Record<string, { id: string; lane: Lane }> = {}
  for (const c of campaigns) {
    if (c.instantlyCampaignId) {
      map[c.instantlyCampaignId] = { id: c.id, lane: c.lane }
    }
  }
  return map
}

export async function loadContactMapByLaneEmail(emails: Array<{ lane: Lane; email: string }>): Promise<Record<string, string>> {
  const contacts = await scanAll<CarrierContact>(getContactTable())
  const map: Record<string, string> = {}
  for (const c of contacts) {
    map[`${c.lane}:${c.email.toLowerCase()}`] = c.id
  }
  return map
}

export async function updateContactStatus(email: string, lane: Lane, status: CarrierContact['status']): Promise<void> {
  const contacts = await scanAll<CarrierContact>(getContactTable(), {
    expression: '#email = :email AND #lane = :lane',
    names: { '#email': 'email', '#lane': 'lane' },
    values: { ':email': email.toLowerCase(), ':lane': lane },
  })
  for (const c of contacts) {
    await ddb.send(
      new UpdateCommand({
        TableName: getContactTable(),
        Key: { id: c.id },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':updatedAt': nowIso() },
      }),
    )
  }
}

export function emailToReply(
  email: InstantlyEmail,
  campaignMap: Record<string, { id: string; lane: Lane }>,
  contactMap: Record<string, string>,
): CarrierReply {
  const instantlyCampaignId = email.campaign_id ?? undefined
  const campaign = instantlyCampaignId ? campaignMap[instantlyCampaignId] : undefined
  const fromEmail = (email.from_address_email ?? email.lead ?? '').toLowerCase().trim()
  const lane = campaign?.lane
  const contactId = lane ? contactMap[`${lane}:${fromEmail}`] : undefined
  const receivedAt = email.timestamp_email && !Number.isNaN(Date.parse(email.timestamp_email))
    ? new Date(email.timestamp_email).toISOString()
    : nowIso()

  return {
    id: makeReplyId(email.id),
    __typename: 'CarrierReply',
    instantlyEmailId: email.id,
    instantlyCampaignId,
    campaignId: campaign?.id,
    lane,
    contactId,
    fromEmail,
    toAccount: email.eaccount ?? '',
    subject: email.subject ?? '',
    textBody: email.body?.text,
    htmlBody: email.body?.html,
    snippet: email.content_preview ?? undefined,
    threadId: email.thread_id ?? undefined,
    receivedAt,
    isAutoReply: email.is_auto_reply === 1,
    status: 'open',
    uniboxUrl: undefined,
  }
}

async function listAccountsAction() {
  const accounts = await listAccounts()
  const normalized = accounts.map(normalizeAccount)
  const usable = normalized.filter((a) => a.ok)
  // Capacity available to carrier blasts = leftover after the JobsDone OS reserve,
  // NOT each mailbox's full daily_limit.
  const totalDailyCapacity = usable.reduce(
    (sum, a) => sum + Math.max(0, a.dailyLimit - JOBSDONE_RESERVE_PER_MAILBOX),
    0,
  )
  return {
    ok: true,
    accounts: normalized,
    totalDailyCapacity,
    defaultPerMailbox: DEFAULT_PER_MAILBOX_PER_DAY,
    reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
    maxPerMailbox: usable.length
      ? Math.min(...usable.map((a) => Math.max(0, a.dailyLimit - JOBSDONE_RESERVE_PER_MAILBOX)))
      : 0,
  }
}

/**
 * Live, shared-mailbox-aware capacity for today.
 *
 * Reads JobsDone OS client state and Instantly's per-account daily analytics to compute
 * exactly how many more carrier-blast emails may be sent today without starving the
 * JobsDone engine. If either upstream call fails we fall back to the static reserve and
 * say so in the returned metadata — we never return "unlimited" and we never throw.
 */
async function getLiveCapacity(
  accounts?: InstantlyAccount[],
): Promise<
  CapacityResult & {
    date: string
    jobsDoneReachable: boolean
    sharedClientsActive: number
    source: 'jobsdone-os' | 'static-fallback'
    note?: string
  }
> {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
  const resolvedAccounts = accounts ?? (await listAccounts())
  const allowedAccounts = resolvedAccounts
    .filter(accountIsOk)
    .map((a) => ({ email: a.email, dailyLimit: a.daily_limit ?? 0 }))

  const jobsDone = await fetchJobsDoneClients()
  const sharedClientsActive = jobsDone.reachable
    ? jobsDone.clients.filter((c) => c.status === 'ACTIVE' && c.instantlyMode === 'SHARED').length
    : 0

  const claimedMailboxes = jobsDone.reachable
    ? jobsDone.clients.flatMap((c) => c.instantlyMailboxes ?? [])
    : []

  let sentToday: Record<string, number> = {}
  let analyticsFailed = false
  let source: 'jobsdone-os' | 'static-fallback' = 'jobsdone-os'
  const notes: string[] = []

  if (!jobsDone.reachable) {
    source = 'static-fallback'
    notes.push('JobsDone OS unreachable; holding full reserve as a fail-safe.')
  }

  try {
    sentToday = await accountDailySends(allowedAccounts.map((a) => a.email), date)
  } catch (err) {
    analyticsFailed = true
    source = 'static-fallback'
    notes.push(
      `Instantly analytics failed; falling back to static reserve. ${err instanceof Error ? err.message : String(err)}`,
    )
    console.error('[carrier-blast-api] getLiveCapacity analytics failed', err)
  }

  const capacity = computeCapacity({
    accounts: allowedAccounts,
    sentToday,
    reservePerMailbox: JOBSDONE_RESERVE_PER_MAILBOX,
    sharedClientsActive,
    // Hold the reserve when JobsDone is unreachable OR when live analytics failed.
    jobsDoneReachable: jobsDone.reachable && !analyticsFailed,
    claimedMailboxes,
  })

  return {
    ...capacity,
    date,
    jobsDoneReachable: jobsDone.reachable,
    sharedClientsActive,
    source,
    note: notes.length > 0 ? notes.join(' ') : undefined,
  }
}

async function capacityAction() {
  const asOf = new Date().toISOString()
  const live = await getLiveCapacity()

  return {
    ok: true,
    asOf,
    date: live.date,
    mailboxes: live.mailboxes,
    perMailboxLimit: live.perMailboxLimit,
    sentToday: live.sentToday,
    reservedForJobsDone: live.reservedForJobsDone,
    availableToday: live.availableToday,
    perMailbox: live.perMailbox,
    jobsDone: {
      reachable: live.jobsDoneReachable,
      sharedClientsActive: live.sharedClientsActive,
      source: live.source,
      note: live.note,
    },
  }
}

/**
 * Launch = validate + mark `pushing` + hand off to `runLaunch` asynchronously.
 *
 * A 3,000-lead push (create + bulk adds + activate + contact stamps) runs well past the
 * AppSync resolver's 30 s cap, so the mutation must return immediately; the UI polls the
 * campaign status. `runLaunch` is the same Lambda invoked with InvocationType Event.
 */
async function launchCampaignAction(payload: { campaignId: string }) {
  const { campaignId } = payload
  if (!campaignId) return { ok: false, error: 'campaignId required' }

  const campaign = await getCampaign(campaignId)
  if (!campaign) return { ok: false, error: 'campaign not found' }
  if (campaign.status === 'pushing') return { ok: true, campaignId, status: 'pushing' }

  const contacts = await scanActiveContactsByLane(campaign.lane)
  if (contacts.length === 0) {
    await updateCampaign(campaignId, { status: 'failed', errorText: 'No active contacts for lane' })
    return { ok: false, error: 'No active contacts for lane' }
  }

  await updateCampaign(campaignId, { status: 'pushing', leadCount: contacts.length, errorText: '' })
  await lambda.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
    InvocationType: 'Event',
    Payload: new TextEncoder().encode(JSON.stringify({ action: 'runLaunch', campaignId })),
  }))
  return { ok: true, campaignId, status: 'pushing', leadCount: contacts.length }
}

async function runLaunchAction(payload: { campaignId: string }) {
  const { campaignId } = payload
  if (!campaignId) return { ok: false, error: 'campaignId required' }

  const campaign = await getCampaign(campaignId)
  if (!campaign) return { ok: false, error: 'campaign not found' }

  const contacts = await scanActiveContactsByLane(campaign.lane)
  if (contacts.length === 0) {
    await updateCampaign(campaignId, { status: 'failed', errorText: 'No active contacts for lane' })
    return { ok: false, error: 'No active contacts for lane' }
  }

  await updateCampaign(campaignId, { status: 'pushing', leadCount: contacts.length })

  let instantlyCampaignId = campaign.instantlyCampaignId
  try {
    if (!instantlyCampaignId) {
      // Reputation + capacity guard. These mailboxes are shared with the JobsDone OS
      // engine, so the per-mailbox take is clamped to (account daily_limit - reserve).
      // Instantly's campaign daily_limit is a campaign-wide TOTAL, hence × sender count.
      const accounts = await listAccounts()
      const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]))
      const requested = campaign.senderAccounts.map((e) => e.toLowerCase())
      const senders = requested.filter((e) => {
        // senderAllowed is checked independently of the account lookup: a mailbox that is
        // denied, or that is not in the workspace listing at all, can never be used.
        if (!senderAllowed(e)) return false
        const a = byEmail.get(e)
        return !!a && accountIsOk(a)
      })
      const skipped = requested.filter((e) => !senders.includes(e))
      if (senders.length === 0) {
        throw new Error(
          'No usable sending mailboxes: must be jobsdone addresses that are active, warmed (score >= 90), and have allowance left after the JobsDone OS reserve',
        )
      }
      // Never exceed any selected mailbox's leftover allowance.
      const perMailbox = Math.max(1, Math.min(
        campaign.dailyLimit ?? DEFAULT_PER_MAILBOX_PER_DAY,
        ...senders.map((e) => maxPerMailbox(byEmail.get(e)!)),
      ))
      const campaignDailyLimit = perMailbox * senders.length

      // Live shared-mailbox capacity: never let a carrier blast starve the JobsDone OS
      // engine. If today has no remaining capacity, fail fast instead of creating a
      // no-op campaign.
      const liveCapacity = await getLiveCapacity(accounts)
      const availableToday = liveCapacity.availableToday
      const effectiveDailyLimit = Math.max(0, Math.min(campaignDailyLimit, availableToday))

      if (availableToday <= 0) {
        const error = `No carrier-blast capacity left today (${liveCapacity.date}): JobsDone OS reserve and live sends have consumed the shared mailbox allowance.`
        await updateCampaign(campaignId, { status: 'failed', errorText: error })
        return { ok: false, error }
      }

      // Persist what is ACTUALLY in force so the UI's days-to-complete math is honest.
      await updateCampaign(campaignId, {
        senderAccounts: senders,
        dailyLimit: perMailbox,
        errorText: skipped.length
          ? `${skipped.length} mailbox(es) skipped (not jobsdone / not warmed / no allowance left): ${skipped.slice(0, 5).join(', ')}`
          : '',
      })
      const created = await createCampaign({
        name: campaign.name,
        email_list: senders,
        daily_limit: effectiveDailyLimit,
        daily_max_leads: effectiveDailyLimit,
        // Spread each mailbox's sends across the working day instead of bursting.
        email_gap: 5,
        random_wait_max: 5,
        sequences: [
          {
            steps: [
              {
                type: 'email',
                delay: 0,
                variants: [{ subject: campaign.subject, body: campaign.bodyHtml }],
              },
            ],
          },
        ],
        campaign_schedule: {
          schedules: [
            {
              name: 'Weekdays Chicago',
              timing: { from: '08:00', to: '17:00' },
              days: { '1': true, '2': true, '3': true, '4': true, '5': true },
              timezone: 'America/Chicago',
            },
          ],
        },
        stop_on_reply: true,
        stop_on_auto_reply: false,
        insert_unsubscribe_header: true,
        link_tracking: false,
        open_tracking: true,
        text_only: false,
      })
      instantlyCampaignId = created.id
      await updateCampaign(campaignId, { instantlyCampaignId })
    }

    const toPush = contacts.filter((c) => c.lastCampaignId !== campaignId || !c.lastSentAt)
    const leads = toPush.map((c) => ({
      email: c.email,
      first_name: c.firstName,
      last_name: c.lastName,
      company_name: c.company,
    }))

    // `toPush` already excludes contacts stamped by a previous (timed-out) attempt, so the
    // slice offset into it starts at 0; `pushedSoFar` only carries the running total.
    let pushedSoFar = campaign.pushedCount ?? 0
    let offset = 0
    for (const batch of chunkLeads(leads, 1000)) {
      await addLeads(instantlyCampaignId, batch)
      const batchContacts = toPush.slice(offset, offset + batch.length)
      const now = nowIso()
      // Stamp in parallel groups of 25 — 3,000 sequential UpdateCommands is slow.
      for (let i = 0; i < batchContacts.length; i += 25) {
        await Promise.all(batchContacts.slice(i, i + 25).map((contact) =>
          ddb.send(new UpdateCommand({
            TableName: getContactTable(),
            Key: { id: contact.id },
            UpdateExpression: 'SET lastCampaignId = :campaignId, lastSentAt = :now',
            ExpressionAttributeValues: { ':campaignId': campaignId, ':now': now },
          })),
        ))
      }
      offset += batch.length
      pushedSoFar += batch.length
      await updateCampaign(campaignId, { pushedCount: pushedSoFar })
    }

    await activateCampaign(instantlyCampaignId)
    await updateCampaign(campaignId, {
      status: 'sending',
      startedAt: nowIso(),
      errorText: '',
    })

    return { ok: true, instantlyCampaignId, leadCount: contacts.length, pushedCount: pushedSoFar }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await updateCampaign(campaignId, { status: 'failed', errorText: message })
    return { ok: false, error: message }
  }
}

async function pauseCampaignAction(payload: { campaignId: string }) {
  const { campaignId } = payload
  if (!campaignId) return { ok: false, error: 'campaignId required' }
  const campaign = await getCampaign(campaignId)
  if (!campaign?.instantlyCampaignId) return { ok: false, error: 'campaign has no instantlyCampaignId' }
  await pauseCampaign(campaign.instantlyCampaignId)
  await updateCampaign(campaignId, { status: 'paused' })
  return { ok: true }
}

async function resumeCampaignAction(payload: { campaignId: string }) {
  const { campaignId } = payload
  if (!campaignId) return { ok: false, error: 'campaignId required' }
  const campaign = await getCampaign(campaignId)
  if (!campaign?.instantlyCampaignId) return { ok: false, error: 'campaign has no instantlyCampaignId' }
  await activateCampaign(campaign.instantlyCampaignId)
  await updateCampaign(campaignId, { status: 'sending' })
  return { ok: true }
}

async function syncCampaignAction(payload: { campaignId: string }) {
  const { campaignId } = payload
  if (!campaignId) return { ok: false, error: 'campaignId required' }
  const campaign = await getCampaign(campaignId)
  if (!campaign?.instantlyCampaignId) return { ok: false, error: 'campaign has no instantlyCampaignId' }

  const rows = await campaignAnalytics(campaign.instantlyCampaignId)
  const row = rows.find((r) => r.campaign_id === campaign.instantlyCampaignId)
  if (!row) return { ok: false, error: 'analytics not found' }

  const completed = row.campaign_status === 3 || row.completed_count >= campaign.leadCount
  await updateCampaign(campaignId, {
    sentCount: row.emails_sent_count,
    openCount: row.open_count,
    replyCount: row.reply_count,
    bounceCount: row.bounced_count,
    unsubscribeCount: row.unsubscribed_count,
    analyticsAt: nowIso(),
    status: completed ? 'completed' : campaign.status,
    completedAt: completed ? nowIso() : campaign.completedAt,
  })
  return { ok: true, analytics: row }
}

async function syncRepliesAction(payload: { campaignId?: string; sinceISO?: string }) {
  const sinceISO =
    payload.sinceISO && !Number.isNaN(Date.parse(payload.sinceISO))
      ? payload.sinceISO
      : new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  let campaignMap: Record<string, { id: string; lane: Lane }>
  let campaignIdFilter: string | undefined

  if (payload.campaignId) {
    const campaign = await getCampaign(payload.campaignId)
    if (!campaign?.instantlyCampaignId) return { ok: false, error: 'campaign not found or not launched' }
    campaignMap = { [campaign.instantlyCampaignId]: { id: campaign.id, lane: campaign.lane } }
    campaignIdFilter = campaign.instantlyCampaignId
  } else {
    campaignMap = await loadCampaignMapByInstantlyId()
    campaignIdFilter = undefined
  }

  const emails = await listReceivedEmails({
    campaignId: campaignIdFilter,
    sinceISO,
  })

  const needed = emails
    .map((e) => {
      const icid = e.campaign_id ?? undefined
      const lane = icid ? campaignMap[icid]?.lane : undefined
      const email = (e.from_address_email ?? e.lead ?? '').toLowerCase().trim()
      return lane ? { lane, email } : null
    })
    .filter(Boolean) as Array<{ lane: Lane; email: string }>

  const contactMap = await loadContactMapByLaneEmail(needed)

  let upserted = 0
  for (const email of emails) {
    try {
      const reply = emailToReply(email, campaignMap, contactMap)
      await putReply(reply)
      upserted++
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // already synced
      } else {
        console.error('[carrier-blast-api] syncReplies putReply error', err)
      }
    }
  }

  return { ok: true, upserted, scanned: emails.length }
}

async function sendReplyAction(payload: { replyId: string; bodyText: string }) {
  const { replyId, bodyText } = payload
  if (!replyId) return { ok: false, error: 'replyId required' }
  if (!bodyText?.trim()) return { ok: false, error: 'bodyText required' }

  const reply = await getReply(replyId)
  if (!reply) return { ok: false, error: 'reply not found' }
  // A reply goes out from the mailbox that received it, so the same sender policy applies.
  // Without this, a stray reply row could push mail out through a cowtown mailbox.
  if (!senderAllowed(reply.toAccount)) {
    return { ok: false, error: `mailbox ${reply.toAccount} is not permitted to send carrier mail` }
  }

  await replyToEmail({
    eaccount: reply.toAccount,
    reply_to_uuid: reply.instantlyEmailId,
    subject: reply.subject.startsWith('Re:') ? reply.subject : `Re: ${reply.subject}`,
    body: { html: textToHtml(bodyText), text: bodyText },
  })

  await ddb.send(
    new UpdateCommand({
      TableName: getReplyTable(),
      Key: { id: replyId },
      UpdateExpression: 'SET lastOutboundAt = :now',
      ExpressionAttributeValues: { ':now': nowIso() },
    }),
  )

  return { ok: true }
}

async function ensureWebhookAction() {
  const url = getWebhookUrl()
  const secret = getWebhookSecret()
  const webhooks = await listWebhooks()
  const existing = webhooks.find(
    (w) => w.target_hook_url === url && w.event_type === 'all_events' && w.status !== -1,
  )
  if (existing) return { ok: true, webhookId: existing.id, url }

  const created = await createWebhook({
    name: 'bcat-ops carrier-blast',
    target_hook_url: url,
    event_type: 'all_events',
    headers: { 'x-bcat-secret': secret },
  })
  return { ok: true, webhookId: created.id, url }
}

async function cronAction() {
  const sinceISO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const replies = await syncRepliesAction({ sinceISO })
  const sending = await scanAll<CarrierCampaign>(getCampaignTable(), {
    expression: '#status = :status',
    names: { '#status': 'status' },
    values: { ':status': 'sending' },
  })
  const synced = []
  for (const c of sending) {
    try {
      const res = await syncCampaignAction({ campaignId: c.id })
      synced.push({ campaignId: c.id, ...res })
    } catch (err) {
      console.error('[carrier-blast-api] cron syncCampaign error', err)
      synced.push({ campaignId: c.id, ok: false, error: (err as Error).message })
    }
  }
  return { ok: true, replies, synced }
}

export const handler = async (event: AppSyncEvent | CronEvent | Record<string, unknown>) => {
  const appSync = event as AppSyncEvent
  const cron = event as CronEvent
  const action = appSync.arguments?.action ?? cron.action
  const payload = (appSync.arguments?.payload ?? {}) as Record<string, unknown>

  if (!action || typeof action !== 'string') {
    return { ok: false, error: 'missing action' }
  }

  try {
    switch (action) {
      case 'listAccounts':
        return await listAccountsAction()
      case 'capacity':
        return await capacityAction()
      case 'launchCampaign':
        return await launchCampaignAction(payload as { campaignId: string })
      case 'runLaunch':
        return await runLaunchAction(
          (appSync.arguments ? payload : (event as { campaignId?: string })) as { campaignId: string },
        )
      case 'pauseCampaign':
        return await pauseCampaignAction(payload as { campaignId: string })
      case 'resumeCampaign':
        return await resumeCampaignAction(payload as { campaignId: string })
      case 'syncCampaign':
        return await syncCampaignAction(payload as { campaignId: string })
      case 'syncReplies':
        return await syncRepliesAction(payload as { campaignId?: string; sinceISO?: string })
      case 'sendReply':
        return await sendReplyAction(payload as { replyId: string; bodyText: string })
      case 'ensureWebhook':
        return await ensureWebhookAction()
      case 'cron':
        return await cronAction()
      default:
        return { ok: false, error: `unknown action: ${action}` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[carrier-blast-api] handler error', err)
    return { ok: false, error: message }
  }
}
