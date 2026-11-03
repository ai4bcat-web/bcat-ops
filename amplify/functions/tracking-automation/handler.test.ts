import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send = send
  }
  class InvokeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return { LambdaClient, InvokeCommand }
})

import { handler } from './handler'

describe('tracking-automation', () => {
  beforeEach(() => {
    send.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME = 'tms-tracking-actions-fn'
  })

  it('invokes the router as the tracking-automation system caller for one AUTO sweep', async () => {
    send.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ mode: 'AUTO', acted: 2 })) })
    const result = await handler()
    expect(result).toEqual({ mode: 'AUTO', acted: 2 })
    const invoke = send.mock.calls[0][0] as { input: { FunctionName: string; InvocationType: string; Payload: Buffer } }
    expect(invoke.input.FunctionName).toBe('tms-tracking-actions-fn')
    expect(invoke.input.InvocationType).toBe('RequestResponse')
    const event = JSON.parse(invoke.input.Payload.toString('utf-8')) as {
      arguments: { action: string; input: string }
      systemCaller: string
      identity?: unknown
    }
    expect(event.systemCaller).toBe('tracking-automation')
    expect(event.identity).toBeUndefined()
    expect(event.arguments.action).toBe('RUN_TRACKING_AUTOMATION')
    expect(JSON.parse(event.arguments.input)).toEqual({ mode: 'AUTO' })
  })

  it('throws when the router returns a function error so the schedule sees the failure', async () => {
    send.mockResolvedValue({ FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'boom' })) })
    await expect(handler()).rejects.toThrow(/boom/)
  })

  it('does nothing when the router name is not configured', async () => {
    delete process.env.TMS_TRACKING_ACTIONS_FUNCTION_NAME
    await expect(handler()).resolves.toEqual({ ran: false })
    expect(send).not.toHaveBeenCalled()
  })
})
