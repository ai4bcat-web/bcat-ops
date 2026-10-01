/**
 * driver-welcome — Cognito PostConfirmation trigger on the driver pool.
 *
 * Fires the moment a driver finishes setting their password. The invite email
 * got them an account; this one gets the app onto their phone, which is the step
 * that actually decides whether they use it.
 *
 * Why a second email rather than putting install steps in the invite: at invite
 * time they are usually at a desk, and the instructions are phone-specific. By
 * the time this fires they have just signed in, so the link lands when it is
 * immediately useful.
 *
 * This trigger must NEVER block sign-up. Cognito treats a thrown error as a
 * failed confirmation, which would leave a driver with a password they cannot
 * use. Every failure here is logged and swallowed.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import type { PostConfirmationTriggerEvent } from 'aws-lambda'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const ses = new SESv2Client({})

const FROM_ADDRESS = process.env.FROM_ADDRESS ?? 'onboarding@bcatcorp.com'
const DRIVER_TABLE = process.env.DRIVER_TABLE_NAME ?? ''
/** Where the PWA lives. Set in backend.ts so the domain is config, not code. */
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN ?? 'https://ops.bcatcorp.com'

/** First name only — the email greets a person, not a record. */
function firstNameOf(fullName: string, fallbackEmail: string): string {
  const first = fullName.trim().split(/\s+/)[0]
  if (first) return first
  const local = fallbackEmail.split('@')[0] ?? ''
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'there'
}

function buildEmail(firstName: string, appUrl: string): { subject: string; text: string } {
  return {
    subject: 'Add the Ivan Cartage driver app to your phone',
    text: `Hi ${firstName},

Your sign-in is set up. Last step is putting the app on your phone so it opens like any other app — no app store needed.

Open this link on your phone:
${appUrl}

iPhone (Safari): tap the Share button, then "Add to Home Screen".
Android (Chrome): tap the three dots, then "Add to Home screen".

Once it's there you can scan rate confirmations and PODs, mark a load en route, on site or delivered, and see your settlements.

— Ivan Cartage`,
  }
}

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  // Only the initial sign-up confirmation; a forgot-password flow fires
  // ConfirmForgotPassword and must not re-send the welcome.
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event

  const email = (event.request.userAttributes.email ?? '').toLowerCase().trim()
  if (!email) return event

  try {
    let name = ''
    if (DRIVER_TABLE) {
      const res = await ddb.send(
        new ScanCommand({
          TableName: DRIVER_TABLE,
          FilterExpression: '#e = :e',
          ExpressionAttributeNames: { '#e': 'email' },
          ExpressionAttributeValues: { ':e': email },
          ProjectionExpression: '#n',
          Limit: 25,
        }),
      )
      name = String(((res.Items ?? [])[0] as { name?: string } | undefined)?.name ?? '')
    }

    const { subject, text } = buildEmail(
      firstNameOf(name, email),
      `${PORTAL_ORIGIN.replace(/\/$/, '')}/driver`,
    )

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM_ADDRESS,
        Destination: { ToAddresses: [email] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    )
    console.log('[driver-welcome] sent app link', { email })
  } catch (err) {
    // Swallow: a failed email must never cost a driver their confirmed account.
    console.error('[driver-welcome] could not send the app link', {
      email,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return event
}
