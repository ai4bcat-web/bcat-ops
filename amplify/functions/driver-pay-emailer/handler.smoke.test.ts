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
  FromEmailAddress: string
  Destination: { ToAddresses: string[]; CcAddresses?: string[] }
  Content: { Raw: { Data: Uint8Array } }
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

describe('driver-pay-emailer smoke', () => {
  it('loads with an empty env and sends nothing at import', () => {
    expect(typeof handler).toBe('function')
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a missing / blank recipient without sending', async () => {
    expect(await call({ pdfBase64: 'QUJD' })).toEqual({ sent: false, error: 'no-recipient' })
    expect(await call({ to: '   ', pdfBase64: 'QUJD' })).toEqual({ sent: false, error: 'no-recipient' })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a missing PDF without sending', async () => {
    expect(await call({ to: 'driver@example.test' })).toEqual({ sent: false, error: 'no-pdf' })
    expect(await call({ to: 'driver@example.test', pdfBase64: '' })).toEqual({ sent: false, error: 'no-pdf' })
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the statement once with the PDF attached (happy path)', async () => {
    const out = await call({
      to: ' driver@example.test ',
      cc: 'a@example.test, b@example.test',
      driverName: 'Jane Roe',
      periodLabel: 'Week 12',
      filename: 'stmt".pdf',
      pdfBase64: 'QUJDREVG',
    })
    expect(out).toEqual({ sent: true, to: 'driver@example.test' })
    expect(send).toHaveBeenCalledTimes(1)
    const input = sentInput()
    expect(input.Destination.ToAddresses).toEqual(['driver@example.test'])
    expect(input.Destination.CcAddresses).toEqual(['a@example.test', 'b@example.test'])
    const raw = new TextDecoder().decode(input.Content.Raw.Data)
    expect(raw).toContain('To: driver@example.test\r\n')
    expect(raw).toContain('Subject: Your pay statement — Week 12\r\n')
    expect(raw).toContain('filename="stmt.pdf"')
    expect(raw).toContain('QUJDREVG')
    expect(raw).toContain('Hi Jane,')
  })

  it('reports a send failure instead of throwing', async () => {
    send.mockRejectedValueOnce(new Error('ses down'))
    expect(await call({ to: 'driver@example.test', pdfBase64: 'QUJD' })).toEqual({ sent: false, error: 'ses down' })
  })
})
