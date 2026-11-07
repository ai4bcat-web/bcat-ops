import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PostConfirmationTriggerEvent } from 'aws-lambda'

const { sesSend, ddbSend } = vi.hoisted(() => {
  delete process.env.FROM_ADDRESS
  delete process.env.DRIVER_TABLE_NAME
  delete process.env.PORTAL_ORIGIN
  return { sesSend: vi.fn(), ddbSend: vi.fn() }
})

vi.mock('@aws-sdk/client-sesv2', () => {
  class SESv2Client { send = sesSend }
  class SendEmailCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  return { SESv2Client, SendEmailCommand }
})
vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {}
  return { DynamoDBClient }
})
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class ScanCommand { input: unknown; constructor(input: unknown) { this.input = input } }
  const DynamoDBDocumentClient = { from: () => ({ send: ddbSend }) }
  return { DynamoDBDocumentClient, ScanCommand }
})

import { handler } from './handler'

interface SentInput {
  Destination: { ToAddresses: string[] }
  Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } } }
}

// mock.calls is untyped; annotate the recorded command so reads are checked.
function sentInput(): SentInput {
  const cmd: { input: SentInput } = sesSend.mock.calls[0][0]
  return cmd.input
}

function ev(triggerSource: string, email?: string): PostConfirmationTriggerEvent {
  return {
    triggerSource,
    request: { userAttributes: email === undefined ? {} : { email } },
  } as unknown as PostConfirmationTriggerEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  sesSend.mockResolvedValue({})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('driver-welcome smoke', () => {
  it('loads with an empty env and sends nothing at import', () => {
    expect(typeof handler).toBe('function')
    expect(sesSend).not.toHaveBeenCalled()
  })

  it('returns the event untouched and sends nothing for a non-sign-up trigger', async () => {
    const e = ev('PostConfirmation_ConfirmForgotPassword', 'd@example.test')
    expect(await handler(e)).toBe(e)
    expect(sesSend).not.toHaveBeenCalled()
  })

  it('sends nothing when the user has no email', async () => {
    const e = ev('PostConfirmation_ConfirmSignUp')
    expect(await handler(e)).toBe(e)
    expect(sesSend).not.toHaveBeenCalled()
  })

  it('emails the normalised address the app link, greeting by email local-part without a driver table', async () => {
    const e = ev('PostConfirmation_ConfirmSignUp', '  Dana@Example.Test ')
    expect(await handler(e)).toBe(e)
    expect(ddbSend).not.toHaveBeenCalled()
    expect(sesSend).toHaveBeenCalledTimes(1)
    const input = sentInput()
    expect(input.Destination.ToAddresses).toEqual(['dana@example.test'])
    expect(input.Content.Simple.Subject.Data).toBe('Add the Ivan Cartage driver app to your phone')
    expect(input.Content.Simple.Body.Text.Data).toContain('Hi Dana,')
    expect(input.Content.Simple.Body.Text.Data).toContain('https://ops.bcatcorp.com/driver')
  })

  it('never blocks sign-up when SES fails', async () => {
    sesSend.mockRejectedValueOnce(new Error('ses down'))
    const e = ev('PostConfirmation_ConfirmSignUp', 'd@example.test')
    await expect(handler(e)).resolves.toBe(e)
  })
})
