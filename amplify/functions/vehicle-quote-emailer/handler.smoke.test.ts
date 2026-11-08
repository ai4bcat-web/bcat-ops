import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { send } = vi.hoisted(() => {
  delete process.env.FROM_ADDRESS
  delete process.env.CC_ADDRESS
  delete process.env.BCC_ADDRESS
  return { send: vi.fn() }
})

vi.mock('@aws-sdk/client-sesv2', () => {
  class SESv2Client { send = send }
  class SendEmailCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { SESv2Client, SendEmailCommand }
})

import { handler } from './handler'
import { LOGO_CID } from './logo'

type Args = Parameters<typeof handler>[0]['arguments']

interface SentInput {
  Destination: { ToAddresses: string[]; CcAddresses?: string[] }
  ReplyToAddresses?: string[]
  Content: {
    Simple?: { Subject: { Data: string }; Body: { Html: { Data: string } } }
    Raw?: { Data: Uint8Array }
  }
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
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('vehicle-quote-emailer smoke', () => {
  it('loads with an empty env and sends nothing at import', () => {
    expect(typeof handler).toBe('function')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a missing recipient without sending', async () => {
    expect(await call({ html: '<p>x</p>' })).toEqual({ sent: false, error: 'no-recipient' })
    expect(await call({ to: '  ', html: '<p>x</p>' })).toEqual({ sent: false, error: 'no-recipient' })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a blank body without sending', async () => {
    expect(await call({ to: 'c@example.test' })).toEqual({ sent: false, error: 'no-body' })
    expect(await call({ to: 'c@example.test', html: '   ' })).toEqual({ sent: false, error: 'no-body' })
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a simple HTML email with the default subject and Cc (happy path)', async () => {
    const out = await call({ to: ' c@example.test ', html: '<p>quote</p>', replyTo: 'r@example.test' })
    expect(out).toMatchObject({ sent: true, to: 'c@example.test' })
    expect(send).toHaveBeenCalledTimes(1)
    const input = sentInput()
    expect(input.Destination.ToAddresses).toEqual(['c@example.test'])
    expect(input.Destination.CcAddresses).toHaveLength(1)
    expect(input.ReplyToAddresses).toEqual(['r@example.test'])
    expect(input.Content.Simple?.Subject.Data).toBe('Your Vehicle Transport Quote — Best Care Auto Transport')
    expect(input.Content.Simple?.Body.Html.Data).toBe('<p>quote</p>')
  })

  it('switches to a raw multipart message when the HTML references the inline logo', async () => {
    await call({ to: 'c@example.test', subject: 'Quote', html: `<img src="cid:${LOGO_CID}">` })
    const input = sentInput()
    expect(input.Content.Simple).toBeUndefined()
    const raw = new TextDecoder().decode(input.Content.Raw?.Data)
    expect(raw).toContain('To: c@example.test\r\n')
    expect(raw).toContain('Subject: Quote\r\n')
    expect(raw).toContain(`Content-ID: <${LOGO_CID}>`)
  })

  it('returns the SES error message instead of throwing', async () => {
    send.mockRejectedValueOnce(new Error('throttled'))
    expect(await call({ to: 'c@example.test', html: '<p>x</p>' })).toEqual({ sent: false, error: 'throttled' })
  })
})
