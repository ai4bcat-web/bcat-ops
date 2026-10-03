/**
 * Driver-app notification slice.
 *
 * Sends the initial rate-confirmation thread opener (Slack + SES) and later POD replies,
 * which go to EMAIL ONLY — a driver's POD does not post to Slack. See notifyPodAdded.
 *
 * WARNING: these functions are called AFTER the upload is persisted. If Slack succeeds
 * and SES fails, the upload must not be lost. We therefore ALWAYS return whatever refs we
 * managed to obtain, even when a channel failed, so the handler can persist them and a
 * later retry has a chance to thread correctly into the channels that already worked.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const ses = new SESv2Client({})

export interface SubmissionNotice {
  submissionId: string
  driverName: string
  referenceNumber?: string | null
  note?: string | null
  attachments: { fileName: string; contentType: string; bytes: Buffer }[]
}

export interface ThreadRefs {
  slackChannelId: string
  slackMessageTs: string
  emailMessageId: string
  emailSubject: string
}

export interface NotifyResult {
  /**
   * Any thread refs we obtained. A partial success is common during isolated preview
   * or network blips; the caller must persist whatever is here so POD replies can thread.
   */
  refs: Partial<ThreadRefs>
  /** Human-readable failure description when one or both channels failed. */
  error?: string
}

/** Split a base64 blob into 76-char MIME lines (RFC 2045). Copied from driver-pay-emailer. */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n')
}

/** MIME encoded-word for subjects with non-ASCII characters. Copied from vehicle-quote-emailer. */
function encodeSubject(s: string): string {
  return /[\u0080-\uFFFF]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`
    : s
}

export const RATECON_SUBJECT_PREFIX = 'New load from '

/**
 * The rate confirmation opener. There is no POD variant: a driver's POD no longer posts
 * to Slack at all — see notifyPodAdded.
 */
function buildSlackText(
  driverName: string,
  referenceNumber: string | null | undefined,
  note: string | null | undefined,
): string {
  return [
    `:package: *New load from ${driverName}* — rate confirmation uploaded`,
    referenceNumber ? `Reference: ${referenceNumber}` : null,
    note ? `Note: ${note}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

async function postSlack(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ ok: true; ts: string } | { ok: false; error: string }> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    return { ok: false, error: 'missing SLACK_BOT_TOKEN' }
  }

  const body: Record<string, unknown> = { channel, text }
  if (threadTs) {
    body.thread_ts = threadTs
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as { ok: boolean; error?: string; ts?: string }
    if (!json.ok) {
      return { ok: false, error: json.error ?? 'slack api error' }
    }
    if (!json.ts) {
      return { ok: false, error: 'slack response missing ts' }
    }
    return { ok: true, ts: json.ts }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildRawEmail(
  to: string,
  from: string,
  subject: string,
  bodyText: string,
  attachments: SubmissionNotice['attachments'],
  threadHeaders?: { inReplyTo: string; references: string },
): Uint8Array {
  const boundary = `=_bcatdriver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  let raw =
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${encodeSubject(subject)}\r\n` +
    (threadHeaders ? `In-Reply-To: ${threadHeaders.inReplyTo}\r\n` : '') +
    (threadHeaders ? `References: ${threadHeaders.references}\r\n` : '') +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
    `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n` +
    `\r\n` +
    `${bodyText}\r\n`

  for (const att of attachments) {
    const filename = att.fileName.replace(/[\r\n"]/g, '')
    const contentType = att.contentType || 'application/octet-stream'
    raw +=
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${contentType}; name="${filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n` +
      `\r\n` +
      `${wrap76(att.bytes.toString('base64'))}\r\n`
  }

  raw += `--${boundary}--\r\n`
  return new TextEncoder().encode(raw)
}

async function sendEmail(
  to: string,
  from: string,
  subject: string,
  bodyText: string,
  attachments: SubmissionNotice['attachments'],
  threadHeaders?: { inReplyTo: string; references: string },
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const raw = buildRawEmail(to, from, subject, bodyText, attachments, threadHeaders)

  try {
    const result = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: { Raw: { Data: raw } },
      }),
    )
    if (!result.MessageId) {
      return { ok: false, error: 'SES response missing MessageId' }
    }
    return {
      ok: true,
      messageId: `<${result.MessageId}@${process.env.AWS_REGION ?? 'us-east-1'}.amazonses.com>`,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function emailBodyText(n: SubmissionNotice, kind: 'ratecon' | 'pod'): string {
  const refLine = n.referenceNumber ? `Reference: ${n.referenceNumber}\n` : ''
  const noteLine = n.note ? `Note: ${n.note}\n` : ''
  if (kind === 'ratecon') {
    return (
      `New load submission from ${n.driverName}\n\n` +
      `${refLine}` +
      `${noteLine}` +
      `Submission ID: ${n.submissionId}\n` +
      `Attachments: ${n.attachments.length} image page(s)\n\n` +
      `Reply to this thread when the POD is ready.`
    )
  }
  return (
    `POD uploaded for ${n.driverName}\n\n` +
    `${refLine}` +
    `${noteLine}` +
    `Submission ID: ${n.submissionId}\n` +
    `Attachments: ${n.attachments.length} image page(s)`
  )
}

function collectResults(
  slackResult: PromiseSettledResult<{ ok: true; ts: string } | { ok: false; error: string }>,
  emailResult: PromiseSettledResult<{ ok: true; messageId: string } | { ok: false; error: string }>,
): { slackMessageTs: string; emailMessageId: string; errors: string[] } {
  const errors: string[] = []
  let slackMessageTs = ''
  let emailMessageId = ''

  if (slackResult.status === 'fulfilled') {
    if (slackResult.value.ok) {
      slackMessageTs = slackResult.value.ts
    } else {
      errors.push(`Slack: ${slackResult.value.error}`)
    }
  } else {
    errors.push(`Slack: ${slackResult.reason instanceof Error ? slackResult.reason.message : String(slackResult.reason)}`)
  }

  if (emailResult.status === 'fulfilled') {
    if (emailResult.value.ok) {
      emailMessageId = emailResult.value.messageId
    } else {
      errors.push(`Email: ${emailResult.value.error}`)
    }
  } else {
    errors.push(`Email: ${emailResult.reason instanceof Error ? emailResult.reason.message : String(emailResult.reason)}`)
  }

  return { slackMessageTs, emailMessageId, errors }
}

export async function notifyRateconSubmitted(n: SubmissionNotice): Promise<NotifyResult> {
  const channel = process.env.INTAKE_IVAN_CHANNEL_ID ?? 'C0B4YJXLYM8'
  const to = process.env.LOADS_EMAIL_TO ?? 'ivanloads@bcatcorp.com'
  const from = process.env.SES_FROM_ADDRESS ?? 'onboarding@bcatcorp.com'
  const subject = `${RATECON_SUBJECT_PREFIX}${n.driverName}`
  const bodyText = emailBodyText(n, 'ratecon')
  const slackText = buildSlackText(n.driverName, n.referenceNumber, n.note)

  const [slackResult, emailResult] = await Promise.allSettled([
    postSlack(channel, slackText),
    sendEmail(to, from, subject, bodyText, n.attachments),
  ])

  const { slackMessageTs, emailMessageId, errors } = collectResults(slackResult, emailResult)

  const refs: Partial<ThreadRefs> = {
    slackChannelId: channel,
    slackMessageTs: slackMessageTs || undefined,
    emailMessageId: emailMessageId || undefined,
    emailSubject: subject,
  }

  return {
    refs,
    error: errors.length > 0 ? `Notification failed (${errors.join('; ')})` : undefined,
  }
}

/**
 * A driver's POD reaches the office by email only.
 *
 * It used to post to Slack as well — into the rate confirmation's thread where there was
 * one, or as a new top-level message where there was not. That is gone. A POD arriving is
 * not news anyone acts on in Slack: the office sees it on the load, on the settlement and
 * in the factoring queue, all of which read the document itself rather than a notification
 * about it. What the Slack post actually produced was noise on every upload, including
 * every replaced page and every added page.
 *
 * The email stays, because ivanloads@ is where the paperwork is filed and the attachment
 * goes with it.
 */
export async function notifyPodAdded(n: SubmissionNotice, refs: Partial<ThreadRefs>): Promise<NotifyResult> {
  const from = process.env.SES_FROM_ADDRESS ?? 'onboarding@bcatcorp.com'
  const to = process.env.LOADS_EMAIL_TO ?? 'ivanloads@bcatcorp.com'
  const subject = refs.emailSubject ? `Re: ${refs.emailSubject}` : `POD for ${n.driverName}`
  const bodyText = emailBodyText(n, 'pod')

  // A POD with a parent email thread replies into it; a standalone one (the PWA upload
  // with no rate con to reply to) opens its own, so it still reaches ivanloads@.
  const parentMessageId = refs.emailMessageId
  const hasParentThread = !!parentMessageId

  const emailResult = await Promise.allSettled([
    parentMessageId
      ? sendEmail(to, from, subject, bodyText, n.attachments, {
          inReplyTo: parentMessageId,
          references: parentMessageId,
        })
      : sendEmail(to, from, subject, bodyText, n.attachments),
  ])

  const errors: string[] = []
  let emailMessageId = ''
  const settled = emailResult[0]
  if (settled.status === 'fulfilled') {
    if (settled.value.ok) emailMessageId = settled.value.messageId
    else errors.push(`Email: ${settled.value.error}`)
  } else {
    errors.push(`Email: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`)
  }

  const outRefs: Partial<ThreadRefs> = {
    // Carried through untouched: a rate confirmation's Slack thread is still its own, and
    // nothing here opens or replies to one any more.
    slackChannelId: refs.slackChannelId,
    slackMessageTs: refs.slackMessageTs,
    emailMessageId: emailMessageId || refs.emailMessageId,
    emailSubject: refs.emailSubject ?? (hasParentThread ? undefined : subject),
  }

  return {
    refs: outRefs,
    error: errors.length > 0 ? `POD notification failed (${errors.join('; ')})` : undefined,
  }
}
