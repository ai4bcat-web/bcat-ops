/**
 * Tests for driver-app-api/notify.ts.
 *
 * The threading contract is invisible until it breaks in production, so these tests
 * verify the exact Slack thread_ts wiring, SES MessageId → RFC-822 Message-ID form,
 * and both In-Reply-To / References headers on the POD reply. They also enforce that
 * partial success never throws away refs, because a later POD must still thread into the
 * channel that succeeded.
 */
import { describe, expect, it, vi, beforeEach, type MockInstance } from 'vitest'
import { SESv2Client, SendEmailCommand, type SendEmailCommandOutput } from '@aws-sdk/client-sesv2'

vi.hoisted(() => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test'
  process.env.INTAKE_IVAN_CHANNEL_ID = 'C0B4YJXLYM8'
  process.env.LOADS_EMAIL_TO = 'ivanloads@bcatcorp.com'
  process.env.SES_FROM_ADDRESS = 'onboarding@bcatcorp.com'
  process.env.AWS_REGION = 'us-east-1'
})

interface SlackResponse {
  ok: boolean
  ts?: string
  error?: string
}

type FetchLike = (url: unknown, init?: { body?: string }) => Promise<{ json: () => Promise<SlackResponse> }>

const fetchMock = vi.fn<FetchLike>(async () => ({
  json: async () => ({ ok: true, ts: '1699999999.000100' }),
}))
vi.stubGlobal('fetch', fetchMock)

const sesSendMock = vi.spyOn(SESv2Client.prototype, 'send') as unknown as MockInstance

import { notifyPodAdded, notifyRateconSubmitted, type SubmissionNotice, type ThreadRefs } from './notify'

const notice = (overrides: Partial<SubmissionNotice> = {}): SubmissionNotice => ({
  submissionId: 'sub-123',
  driverName: 'José Doe',
  referenceNumber: 'VRID-456',
  note: 'Dock 5',
  attachments: [
    { fileName: 'ratecon.jpg', contentType: 'image/jpeg', bytes: Buffer.from('image1') },
    { fileName: 'ratecon2.jpg', contentType: 'image/jpeg', bytes: Buffer.from('image2') },
  ],
  ...overrides,
})

const slackBody = (n = 0) =>
  JSON.parse(fetchMock.mock.calls[n][1]?.body ?? '{}') as {
    channel: string
    text: string
    thread_ts?: string
  }

const sentEmailRaw = (n = 0) => {
  const cmd = sesSendMock.mock.calls[n][0] as InstanceType<typeof SendEmailCommand>
  const data = cmd.input.Content?.Raw?.Data
  if (!data) throw new Error('missing raw email data')
  return new TextDecoder().decode(data)
}

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1699999999.000100' }) })
  sesSendMock.mockClear()
  sesSendMock.mockImplementation(async () => ({ MessageId: 'ses-message-id-123' }) as SendEmailCommandOutput)
})

describe('notifyRateconSubmitted', () => {
  it('posts a top-level Slack message whose text leads with the driver name', async () => {
    await notifyRateconSubmitted(notice())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage')

    const body = slackBody()
    expect(body.channel).toBe('C0B4YJXLYM8')
    expect(body.thread_ts).toBeUndefined()
    expect(body.text).toMatch(/^:package: \*New load from José Doe\*/)
    expect(body.text).toContain('Reference: VRID-456')
    expect(body.text).toContain('Note: Dock 5')
  })

  it('sends a raw MIME email with the driver name in the subject and every attachment', async () => {
    await notifyRateconSubmitted(notice({ driverName: 'Jane Doe' }))

    expect(sesSendMock).toHaveBeenCalledTimes(1)

    const cmd = sesSendMock.mock.calls[0][0] as InstanceType<typeof SendEmailCommand>
    expect(cmd.input.FromEmailAddress).toBe('onboarding@bcatcorp.com')
    expect(cmd.input.Destination?.ToAddresses).toEqual(['ivanloads@bcatcorp.com'])

    const raw = sentEmailRaw()
    expect(raw).toContain('Subject: New load from Jane Doe')
    expect(raw).toContain('From: onboarding@bcatcorp.com')
    expect(raw).toContain('To: ivanloads@bcatcorp.com')
    expect(raw).toContain('Content-Type: multipart/mixed; boundary=')
    expect(raw).toContain('Content-Disposition: attachment; filename="ratecon.jpg"')
    expect(raw).toContain(Buffer.from('image1').toString('base64'))
    expect(raw).toContain(Buffer.from('image2').toString('base64'))
  })

  it('encodes a non-ASCII driver name in the subject using MIME encoded-word', async () => {
    await notifyRateconSubmitted(notice())
    const raw = sentEmailRaw()
    expect(raw).toContain('Subject: =?UTF-8?B?')
    expect(raw).toContain(Buffer.from('New load from José Doe').toString('base64'))
  })

  it('returns refs and no error when both channels succeed', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, ts: '1234.5678' }) })
    const result = await notifyRateconSubmitted(notice())
    expect(result.error).toBeUndefined()
    expect(result.refs.emailMessageId).toBe('<ses-message-id-123@us-east-1.amazonses.com>')
    expect(result.refs.slackChannelId).toBe('C0B4YJXLYM8')
    expect(result.refs.slackMessageTs).toBe('1234.5678')
    expect(result.refs.emailSubject).toBe('New load from José Doe')
  })

  it('derives the SES region from AWS_REGION', async () => {
    const saved = process.env.AWS_REGION
    process.env.AWS_REGION = 'us-west-2'
    try {
      const result = await notifyRateconSubmitted(notice())
      expect(result.refs.emailMessageId).toBe('<ses-message-id-123@us-west-2.amazonses.com>')
    } finally {
      process.env.AWS_REGION = saved
    }
  })

  it('keeps Slack refs and still sends email when Slack fails', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'not_in_channel' }) })

    const result = await notifyRateconSubmitted(notice())
    expect(result.error).toContain('Slack: not_in_channel')
    expect(result.refs.emailMessageId).toBe('<ses-message-id-123@us-east-1.amazonses.com>')
    expect(result.refs.slackChannelId).toBe('C0B4YJXLYM8')
    expect(result.refs.slackMessageTs).toBeUndefined()
    expect(sesSendMock).toHaveBeenCalledTimes(1)
  })

  it('keeps Slack refs when SES fails', async () => {
    sesSendMock.mockRejectedValue(new Error('SES throttled'))

    const result = await notifyRateconSubmitted(notice())
    expect(result.error).toContain('Email: SES throttled')
    expect(result.refs.slackChannelId).toBe('C0B4YJXLYM8')
    expect(result.refs.slackMessageTs).toBe('1699999999.000100')
    expect(result.refs.emailMessageId).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports both channels when both fail', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'channel_not_found' }) })
    sesSendMock.mockRejectedValue(new Error('SES down'))

    const result = await notifyRateconSubmitted(notice())
    expect(result.error).toContain('Slack: channel_not_found')
    expect(result.error).toContain('Email: SES down')
    expect(result.refs.slackMessageTs).toBeUndefined()
    expect(result.refs.emailMessageId).toBeUndefined()
  })
})

describe('notifyPodAdded', () => {
  const parentRefs = (): ThreadRefs => ({
    slackChannelId: 'C0B4YJXLYM8',
    slackMessageTs: '1699999999.000100',
    emailMessageId: '<parent-msg-id@us-east-1.amazonses.com>',
    emailSubject: 'New load from Jane Doe',
  })

  it('posts the POD as a threaded reply using the parent ts', async () => {
    await notifyPodAdded(notice({ driverName: 'Jane Doe', note: null }), parentRefs())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = slackBody()
    expect(body.channel).toBe(parentRefs().slackChannelId)
    expect(body.thread_ts).toBe(parentRefs().slackMessageTs)
    expect(body.text).toMatch(/^:page_facing_up: \*POD uploaded\* for Jane Doe/)
  })

  it('sends the POD email with both In-Reply-To and References headers', async () => {
    await notifyPodAdded(notice({ driverName: 'Jane Doe', referenceNumber: null }), parentRefs())

    const raw = sentEmailRaw()
    expect(raw).toContain(`In-Reply-To: ${parentRefs().emailMessageId}`)
    expect(raw).toContain(`References: ${parentRefs().emailMessageId}`)
    expect(raw).toContain('Subject: Re: New load from Jane Doe')
    expect(raw).toContain('Content-Disposition: attachment; filename="ratecon.jpg"')
  })

  it('keeps the Slack thread ref when the threaded Slack post fails but the email succeeds', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'not_in_channel' }) })
    const result = await notifyPodAdded(notice(), parentRefs())
    expect(result.error).toContain('Slack: not_in_channel')
    expect(sesSendMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the email thread ref when the POD email fails', async () => {
    sesSendMock.mockRejectedValue(new Error('SES quota exceeded'))
    const result = await notifyPodAdded(notice(), parentRefs())
    expect(result.error).toContain('Email: SES quota exceeded')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.refs.slackMessageTs).toBe(parentRefs().slackMessageTs)
    expect(result.refs.emailMessageId).toBe(parentRefs().emailMessageId)
  })

  it('falls back to a top-level Slack post only when no parent slackMessageTs is present', async () => {
    await notifyPodAdded(
      notice({ driverName: 'Solo' }),
      { slackChannelId: 'C0B4YJXLYM8', slackMessageTs: '', emailMessageId: '<e@amazonses.com>', emailSubject: 'New load from Solo' },
    )
    const body = slackBody()
    expect(body.channel).toBe('C0B4YJXLYM8')
    expect(body.thread_ts).toBeUndefined()
  })

  it('skips the email reply when no parent emailMessageId is present', async () => {
    const result = await notifyPodAdded(
      notice({ driverName: 'NoEmail' }),
      { slackChannelId: 'C0B4YJXLYM8', slackMessageTs: '1699999999.000100', emailMessageId: '', emailSubject: '' },
    )
    expect(sesSendMock).not.toHaveBeenCalled()
    expect(result.refs.slackMessageTs).toBe('1699999999.000100')
    expect(result.error).toContain('Email: no parent email thread')
  })
})
