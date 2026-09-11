/**
 * Thin typed client for the Instantly.ai API (v2).
 * Handles Bearer auth, JSON bodies, 429/5xx retries with exponential backoff,
 * and pagination helpers for endpoints that return { items, next_starting_after }.
 */

const BASE_URL = 'https://api.instantly.ai'

function getApiKey(): string {
  const key = process.env.INSTANTLY_API_KEY
  if (!key) throw new Error('INSTANTLY_API_KEY is not configured')
  return key
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type InstantlyAccount = {
  email: string
  status: number
  warmup_status: number
  daily_limit: number | null
  stat_warmup_score: number | null
  provider_code: number
  setup_pending: boolean
  status_message?: unknown
}

export type InstantlyCampaign = {
  id: string
  name: string
  status: number
  email_list?: string[]
  daily_limit?: number | null
}

export type InstantlyLead = {
  email: string
  first_name?: string
  last_name?: string
  company_name?: string
  custom_variables?: Record<string, unknown>
}

export type AddLeadsSummary = {
  status?: string
  total_sent?: number
  leads_uploaded?: number
  duplicated_leads?: number
  duplicate_email_count?: number
  invalid_email_count?: number
  in_blocklist?: number
  incomplete_count?: number
  skipped_count?: number
  remaining_in_plan?: number
  created_leads?: number
}

export type InstantlyAnalytics = {
  campaign_id: string
  campaign_name: string
  campaign_status: number
  leads_count: number
  contacted_count: number
  emails_sent_count: number
  open_count: number
  reply_count: number
  bounced_count: number
  unsubscribed_count: number
  completed_count: number
}

export type InstantlyEmail = {
  id: string
  timestamp_email?: string
  subject: string
  from_address_email?: string | null
  to_address_email_list?: string
  body?: { text?: string; html?: string }
  campaign_id?: string | null
  eaccount?: string
  lead?: string | null
  thread_id?: string | null
  is_auto_reply?: number | null
  i_status?: number | null
  content_preview?: string | null
  ue_type?: number | null
}

export type InstantlyWebhook = {
  id: string
  name?: string | null
  target_hook_url: string
  event_type?: string | null
  campaign?: string | null
  headers?: Record<string, string> | null
  status?: number | null
}

export type CampaignCreate = {
  name: string
  email_list: string[]
  daily_limit?: number
  /** Minutes between sends per mailbox; random_wait_max adds jitter on top. */
  email_gap?: number
  random_wait_max?: number
  sequences: Array<{
    steps: Array<{
      type: 'email'
      delay: number
      variants: Array<{ subject: string; body: string; v_disabled?: boolean }>
    }>
  }>
  campaign_schedule: {
    schedules: Array<{
      name: string
      timing: { from: string; to: string }
      days: Record<string, boolean>
      timezone: string
    }>
  }
  stop_on_reply?: boolean
  stop_on_auto_reply?: boolean
  insert_unsubscribe_header?: boolean
  link_tracking?: boolean
  open_tracking?: boolean
  text_only?: boolean
  daily_max_leads?: number
}

export type ReplyBody = {
  eaccount: string
  reply_to_uuid: string
  subject: string
  body: { html?: string; text?: string }
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export async function instantlyFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`
  const key = getApiKey()

  let lastErr: Error | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      })

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const text = await res.text().catch(() => '')
        lastErr = new Error(`Instantly ${res.status} ${path}: ${text}`)
        await sleep(1000 * 2 ** attempt)
        continue
      }

      if (res.status === 401) {
        const text = await res.text().catch(() => '')
        throw new Error(`Instantly 401 ${path}: ${text}`)
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Instantly ${res.status} ${path}: ${text}`)
      }

      return (await res.json()) as T
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (lastErr.message.startsWith('Instantly 401')) throw lastErr
      await sleep(1000 * 2 ** attempt)
    }
  }

  throw lastErr ?? new Error(`Instantly request failed after retries: ${path}`)
}

export async function paginateItems<T>(
  path: string,
  baseParams: Record<string, string | number | boolean | undefined>,
  pages = Infinity,
): Promise<T[]> {
  const items: T[] = []
  let startingAfter: string | undefined
  let page = 0

  while (page < pages) {
    const params = { ...baseParams, starting_after: startingAfter }
    const res = await instantlyFetch<{ items: T[]; next_starting_after?: string }>(
      `${path}${buildQuery(params)}`,
    )
    items.push(...(res.items ?? []))
    startingAfter = res.next_starting_after
    if (!startingAfter) break
    page++
  }

  return items
}

export async function listAccounts(): Promise<InstantlyAccount[]> {
  return paginateItems<InstantlyAccount>('/api/v2/accounts', { limit: 100 })
}

export async function createCampaign(body: CampaignCreate): Promise<InstantlyCampaign> {
  return instantlyFetch<InstantlyCampaign>('/api/v2/campaigns', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function chunkLeads<T>(leads: T[], size = 1000): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < leads.length; i += size) {
    chunks.push(leads.slice(i, i + size))
  }
  return chunks
}

export async function addLeads(
  campaignId: string,
  leads: InstantlyLead[],
): Promise<AddLeadsSummary[]> {
  const summaries: AddLeadsSummary[] = []
  for (const chunk of chunkLeads(leads, 1000)) {
    const res = await instantlyFetch<AddLeadsSummary>('/api/v2/leads/add', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: campaignId, leads: chunk }),
    })
    summaries.push(res)
  }
  return summaries
}

export async function activateCampaign(id: string): Promise<InstantlyCampaign> {
  return instantlyFetch<InstantlyCampaign>(`/api/v2/campaigns/${id}/activate`, {
    method: 'POST',
  })
}

export async function pauseCampaign(id: string): Promise<InstantlyCampaign> {
  return instantlyFetch<InstantlyCampaign>(`/api/v2/campaigns/${id}/pause`, {
    method: 'POST',
  })
}

export async function campaignAnalytics(id: string): Promise<InstantlyAnalytics[]> {
  return instantlyFetch<InstantlyAnalytics[]>(`/api/v2/campaigns/analytics${buildQuery({ id })}`)
}

export async function listReceivedEmails(options?: {
  campaignId?: string
  sinceISO?: string
  pages?: number
}): Promise<InstantlyEmail[]> {
  return paginateItems<InstantlyEmail>(
    '/api/v2/emails',
    {
      email_type: 'received',
      limit: 100,
      sort_order: 'desc',
      min_timestamp_created: options?.sinceISO,
      campaign_id: options?.campaignId,
    },
    options?.pages,
  )
}

export async function replyToEmail(body: ReplyBody): Promise<InstantlyEmail> {
  return instantlyFetch<InstantlyEmail>('/api/v2/emails/reply', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function listWebhooks(): Promise<InstantlyWebhook[]> {
  return paginateItems<InstantlyWebhook>('/api/v2/webhooks', { limit: 100 })
}

export async function createWebhook(
  body: Omit<Partial<InstantlyWebhook>, 'id'> & { target_hook_url: string; event_type: string },
): Promise<InstantlyWebhook> {
  return instantlyFetch<InstantlyWebhook>('/api/v2/webhooks', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export type InstantlyDailyAnalytics = {
  date: string
  email_account: string
  sent: number
  bounced?: number
  contacted?: number
  replies?: number
  unsubscribed?: number
  [key: string]: unknown
}

const ANALYTICS_CHUNK_SIZE = 15

/**
 * Live per-mailbox send count for a single calendar day.
 *
 * The Instantly analytics endpoint 413s when too many emails are requested at once,
 * so we chunk the mailbox list and merge the results. A single chunk failure is logged
 * and those mailboxes are treated as unknown; if every chunk fails we throw so the
 * caller can fall back to the static reserve.
 */
export async function accountDailySends(
  emails: string[],
  date: string,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  if (emails.length === 0) return result

  const chunks: string[][] = []
  for (let i = 0; i < emails.length; i += ANALYTICS_CHUNK_SIZE) {
    chunks.push(emails.slice(i, i + ANALYTICS_CHUNK_SIZE))
  }

  let failures = 0
  for (const chunk of chunks) {
    // Build the emails value ourselves: each address is URL-encoded, then joined with a
    // literal comma. Using buildQuery would encode the comma separators a second time.
    const emailsParam = chunk.map(encodeURIComponent).join(',')
    const query = `?start_date=${encodeURIComponent(date)}&end_date=${encodeURIComponent(date)}&emails=${emailsParam}`
    try {
      const rows = await instantlyFetch<InstantlyDailyAnalytics[]>(
        `/api/v2/accounts/analytics/daily${query}`,
      )
      for (const row of rows) {
        const email = row.email_account.toLowerCase()
        result[email] = (result[email] ?? 0) + (row.sent ?? 0)
      }
    } catch (err) {
      failures++
      console.error('[instantly] accountDailySends chunk failed', { date, chunk, err })
    }
  }

  if (failures === chunks.length && chunks.length > 0) {
    throw new Error(`accountDailySends failed for all ${chunks.length} chunk(s) on ${date}`)
  }

  return result
}

