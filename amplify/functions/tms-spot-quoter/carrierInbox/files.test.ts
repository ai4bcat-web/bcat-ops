import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InvokeCommand } from '@aws-sdk/client-lambda'
import { createLambdaFiles } from './files'
import { offerRaw } from './testkit'
import { normalizeInboundExtraction } from '../../../../src/lib/carrierInbox/normalize'
import type { FileInboundOfferInput } from '../../../../src/lib/carrierInbox/types'

const INPUT: FileInboundOfferInput = {
  source: 'EMAIL', sourceKey: 'a'.repeat(20), mailboxId: 'm1', boardProvider: null, receivedAt: '2026-11-04T17:00:00Z',
  fromEmail: 'x@carrier.example.invalid', fromName: null, to: [], cc: [], subject: 's', body: 'b', messageId: null, inReplyTo: null,
  attachments: [], authOk: true,
  extraction: normalizeInboundExtraction(offerRaw(), { receivedAt: '2026-11-04T17:00:00Z', senderEmail: null, authOk: true, boardProvider: null }),
}

function lambda(reply: { Payload?: string; FunctionError?: string }): { sent: InvokeCommand[]; send: (c: InvokeCommand) => Promise<unknown> } {
  const sent: InvokeCommand[] = []
  return {
    sent,
    async send(c) {
      sent.push(c)
      return { Payload: reply.Payload === undefined ? undefined : Buffer.from(reply.Payload), FunctionError: reply.FunctionError }
    },
  }
}

describe('router hand-over', () => {
  it('invokes the router synchronously as the carrier-inbox system caller, for FILE_INBOUND_OFFER only', async () => {
    const l = lambda({ Payload: JSON.stringify({ outcome: 'FILED', messageId: 'msg:cs:x', shipmentId: 's', quoteId: 'q', score: 0.9, how: 'LOAD_REF_SUBJECT' }) })
    const files = createLambdaFiles(l as never, () => 'router-fn')
    const result = await files.fileInboundOffer(INPUT)
    expect(result.outcome).toBe('FILED')
    const sent = l.sent[0].input
    expect(sent).toMatchObject({ FunctionName: 'router-fn', InvocationType: 'RequestResponse' })
    const event = JSON.parse(Buffer.from(sent.Payload as Uint8Array).toString('utf8')) as { arguments: { action: string; input: string }; systemCaller: string }
    expect(event.systemCaller).toBe('carrier-inbox')
    expect(event.arguments.action).toBe('FILE_INBOUND_OFFER')
    expect(JSON.parse(event.arguments.input)).toMatchObject({ sourceKey: INPUT.sourceKey })
  })

  it('throws on a router error so the poll holds the cursor', async () => {
    const files = createLambdaFiles(lambda({ FunctionError: 'Unhandled', Payload: JSON.stringify({ errorMessage: 'Forbidden: nope' }) }) as never, () => 'fn')
    await expect(files.fileInboundOffer(INPUT)).rejects.toThrow(/Forbidden: nope/)
    const noOutcome = createLambdaFiles(lambda({ Payload: '{}' }) as never, () => 'fn')
    await expect(noOutcome.fileInboundOffer(INPUT)).rejects.toThrow(/no outcome/)
    const unset = createLambdaFiles(lambda({ Payload: '{}' }) as never, () => '')
    await expect(unset.fileInboundOffer(INPUT)).rejects.toThrow(/not set/)
  })
})

describe('read-only mailbox', () => {
  it('no carrier-inbox source touches a Gmail or SES write', () => {
    const dir = __dirname
    const forbidden = /\b(sendMessage|createDraft|updateDraft|sendDraft|sendReply|modifyMessage|batchModify|messages\.send|drafts\.create|gmail\.send|gmail\.modify|gmail\.compose|SendEmailCommand|SESClient)\b/
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(5)
    for (const f of sources) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(forbidden)
  })
})
