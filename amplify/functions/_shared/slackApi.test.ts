import { describe, it, expect } from 'vitest'
import { slackClient } from './slackApi'

describe('slackClient', () => {
  it('form-encodes every call (Slack read methods reject JSON) and JSON-encodes nested values', async () => {
    const seen: Array<{ url: string; body: string; type: string }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body), type: String((init?.headers as Record<string, string>)['Content-Type']) })
      return new Response(JSON.stringify({ ok: true, user: { id: 'U1' } }), { status: 200 })
    }) as typeof fetch
    const c = slackClient('xoxb-test', fetchImpl)
    await c.call('users.lookupByEmail', { email: 'a@b.com' })
    await c.call('files.completeUploadExternal', { files: [{ id: 'F1', title: 't' }], channel_id: 'C1', thread_ts: undefined })
    expect(seen[0].type).toContain('x-www-form-urlencoded')
    expect(seen[0].body).toBe('email=a%40b.com')
    expect(new URLSearchParams(seen[1].body).get('files')).toBe('[{"id":"F1","title":"t"}]')
    expect(new URLSearchParams(seen[1].body).has('thread_ts')).toBe(false)
  })
  it('throws Slack’s own error code', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), { status: 200 })) as typeof fetch
    await expect(slackClient('x', fetchImpl).call('conversations.create', { name: 'x' })).rejects.toThrow('Slack conversations.create: missing_scope')
  })
})
