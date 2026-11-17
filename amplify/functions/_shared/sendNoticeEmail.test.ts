import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SESv2Client } from '@aws-sdk/client-sesv2'
import { sendNoticeEmail } from './shipmentNotices'
import { decodeNoticeTag } from '../ses-delivery-events/deliveryEvent'

function fakeSes() {
  const sent: Record<string, unknown>[] = []
  const ses = { send: vi.fn(async (cmd: { input: Record<string, unknown> }) => { sent.push(cmd.input); return { MessageId: 'm-1' } }) }
  return { ses: ses as unknown as SESv2Client, sent }
}

afterEach(() => { delete process.env.SES_CONFIGURATION_SET })

describe('sendNoticeEmail', () => {
  it('tags the send with its notice and configuration set, and sets Reply-To', async () => {
    process.env.SES_CONFIGURATION_SET = 'bcat-notices-main'
    const { ses, sent } = fakeSes()
    await sendNoticeEmail(ses, {
      from: 'billing@bcatcorp.com', to: ['ap@customer.com'], cc: ['invoices@bcatcorp.com'],
      replyTo: 'ai4bcat+tracking.shp-1@gmail.com', noticeId: 'inv:20027:2', subject: 'Invoice', body: 'Hi',
    })
    const input = sent[0] as { ConfigurationSetName: string; EmailTags: { Name: string; Value: string }[]; FromEmailAddress: string; Content: { Raw: { Data: Uint8Array } } }
    expect(input.FromEmailAddress).toBe('billing@bcatcorp.com')
    expect(input.ConfigurationSetName).toBe('bcat-notices-main')
    expect(decodeNoticeTag(input.EmailTags[0].Value)).toBe('inv:20027:2')
    const raw = new TextDecoder().decode(input.Content.Raw.Data)
    expect(raw).toContain('Reply-To: ai4bcat+tracking.shp-1@gmail.com\r\n')
    expect(raw).toContain('Cc: invoices@bcatcorp.com\r\n')
  })

  it('sends without a configuration set or tags where none is configured', async () => {
    const { ses, sent } = fakeSes()
    await sendNoticeEmail(ses, { from: 'notifications@bcatcorp.com', to: ['a@b.com'], subject: 's', body: 'b' })
    expect(sent[0]).toMatchObject({ ConfigurationSetName: undefined, EmailTags: undefined })
    expect(new TextDecoder().decode((sent[0] as { Content: { Raw: { Data: Uint8Array } } }).Content.Raw.Data)).not.toContain('Reply-To')
  })

  it('sends plain text plus an HTML twin as multipart/alternative, with or without an attachment', async () => {
    const { ses, sent } = fakeSes()
    const decode = (i: number) => new TextDecoder().decode((sent[i] as { Content: { Raw: { Data: Uint8Array } } }).Content.Raw.Data)
    await sendNoticeEmail(ses, { from: 'a@b.com', to: ['c@d.com'], subject: 's', body: 'plain', htmlBody: '<table></table>' })
    expect(decode(0)).toContain('Content-Type: multipart/alternative')
    expect(decode(0)).toContain('Content-Type: text/html; charset=UTF-8')
    await sendNoticeEmail(ses, {
      from: 'a@b.com', to: ['c@d.com'], subject: 's', body: 'plain', htmlBody: '<table></table>',
      attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }],
    })
    expect(decode(1)).toContain('Content-Type: multipart/mixed')
    expect(decode(1)).toContain('multipart/alternative')
    expect(decode(1)).toContain('filename="r.pdf"')
  })
})
