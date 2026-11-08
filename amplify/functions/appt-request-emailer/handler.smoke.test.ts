import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { send } = vi.hoisted(() => {
  delete process.env.FROM_ADDRESS
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-sesv2', () => {
  class SESv2Client { send = send }
  class SendEmailCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { SESv2Client, SendEmailCommand }
})

import { handler } from './handler'

type Args = Parameters<typeof handler>[0]['arguments']

interface SentInput {
  Destination: { ToAddresses: string[]; CcAddresses?: string[] }
  ReplyToAddresses: string[]
  Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } }
}

// mock.calls is untyped; annotate the recorded command so reads are checked.
function sentInput(): SentInput {
  const cmd: { input: SentInput } = send.mock.calls[0][0]
  return cmd.input
}

const call = (a: Partial<Args>) => handler({ arguments: a as Args })

beforeEach(() => {
  vi.clearAllMocks()
  send.mockResolvedValue({})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('appt-request-emailer smoke', () => {
  it('loads with an empty env and sends nothing at import', () => {
    expect(typeof handler).toBe('function')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses when to, subject or body is missing, without sending', async () => {
    const expected = { ok: false, error: 'to, subject and body are required' }
    expect(await call({ subject: 's', body: 'b' })).toEqual(expected)
    expect(await call({ to: 'a@example.test', body: 'b' })).toEqual(expected)
    expect(await call({ to: 'a@example.test', subject: 's' })).toEqual(expected)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a simple text email (happy path)', async () => {
    expect(await call({ to: 'dock@example.test', cc: 'cc@example.test', subject: 'Appt', body: 'Hello', replyTo: 'me@example.test' }))
      .toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(1)
    const input = sentInput()
    expect(input.Destination).toEqual({ ToAddresses: ['dock@example.test'], CcAddresses: ['cc@example.test'] })
    expect(input.ReplyToAddresses).toEqual(['me@example.test'])
    expect(input.Content.Simple.Subject.Data).toBe('Appt')
    expect(input.Content.Simple.Body.Text.Data).toBe('Hello')
  })

  it('omits Cc when none is given', async () => {
    await call({ to: 'dock@example.test', subject: 'Appt', body: 'Hello' })
    const input = sentInput()
    expect(input.Destination).toEqual({ ToAddresses: ['dock@example.test'] })
  })

  it('returns the SES error message instead of throwing', async () => {
    send.mockRejectedValueOnce(new Error('rejected'))
    expect(await call({ to: 'dock@example.test', subject: 'Appt', body: 'Hello' })).toEqual({ ok: false, error: 'rejected' })
  })
})
