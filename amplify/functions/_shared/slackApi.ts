/**
 * The slice of Slack's Web API the dispatch bridge uses. Thin on purpose: every call is
 * one fetch, errors carry Slack's own `error` string, and `fetchImpl` is injectable so
 * the bridge logic can be tested without the network.
 */
export class SlackError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method}: ${code}`)
    this.name = 'SlackError'
  }
}

export interface SlackClient {
  call: <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) => Promise<T>
  /** Download a file Slack holds (url_private) with the bot's token. */
  download: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>
  /** Upload bytes into a channel (files:write). Returns the Slack file id. */
  upload: (input: { channel: string, filename: string, bytes: Uint8Array, title?: string, threadTs?: string }) => Promise<string>
}

export function slackClient(token: string, fetchImpl: typeof fetch = fetch): SlackClient {
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    // Form-encoded, not JSON: Slack's read methods (users.lookupByEmail, conversations.list,
    // conversations.members) answer `invalid_arguments` to a JSON body, and every write
    // method accepts a form. Arrays and objects (files, blocks) go in as JSON strings.
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
    })
    const json = await res.json() as { ok?: boolean; error?: string } & T
    if (!json.ok) throw new SlackError(method, json.error ?? `http_${res.status}`)
    return json
  }
  const download = async (url: string) => {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new SlackError('download', `http_${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
  }
  const upload = async (input: { channel: string; filename: string; bytes: Uint8Array; title?: string; threadTs?: string }) => {
    // files.getUploadURLExternal wants a form, not JSON.
    const q = new URLSearchParams({ filename: input.filename, length: String(input.bytes.byteLength) })
    const res = await fetchImpl(`https://slack.com/api/files.getUploadURLExternal?${q}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
    const ticket = await res.json() as { ok?: boolean; error?: string; upload_url?: string; file_id?: string }
    if (!ticket.ok || !ticket.upload_url || !ticket.file_id) throw new SlackError('files.getUploadURLExternal', ticket.error ?? 'no_url')
    const put = await fetchImpl(ticket.upload_url, { method: 'POST', body: new Blob([input.bytes as BlobPart]) })
    if (!put.ok) throw new SlackError('upload', `http_${put.status}`)
    await call('files.completeUploadExternal', {
      files: [{ id: ticket.file_id, title: input.title ?? input.filename }],
      channel_id: input.channel,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    })
    return ticket.file_id
  }
  return { call, download, upload }
}
