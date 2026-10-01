/**
 * The app sign-in invite is the piece a person presses and then watches, so the two
 * ways it could silently fail are what these tests pin down: being swallowed by the
 * portal-email pause switch, and pointing a hired driver at the hiring portal instead
 * of at a page where they can set a password.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const INVITE_TABLE = 'InviteTestTable'
const DRIVER_TABLE = 'DriverTestTable'
const SETTINGS_TABLE = 'SettingsTestTable'
const BASE = 'https://ops.bcatcorp.com'

type Handler = (event: { arguments: Record<string, unknown> }) => Promise<Record<string, unknown>>

/** Env is read at module scope, so the handler has to be imported after it is set. */
async function loadHandler(): Promise<Handler> {
  process.env.INVITE_TABLE_NAME = INVITE_TABLE
  process.env.DRIVER_TABLE_NAME = DRIVER_TABLE
  process.env.SETTINGS_TABLE_NAME = SETTINGS_TABLE
  process.env.PORTAL_BASE_URL = BASE
  vi.resetModules()
  return (await import('./handler')).handler as unknown as Handler
}

interface Scenario {
  /** false = emails paused, the default when no settings row exists. */
  portalEmails?: boolean | 'no-row'
  invite?: Record<string, unknown>
  driver?: Record<string, unknown>
  /** Rows before the matching one, each on its own page, to exercise pagination. */
  inviteDecoyPages?: number
}

function mockAws(s: Scenario) {
  let invitePage = 0
  const ddb = vi
    .spyOn(DynamoDBDocumentClient.prototype, 'send')
    .mockImplementation(async (command: unknown) => {
      if (!(command instanceof ScanCommand)) return undefined
      const table = command.input.TableName

      if (table === SETTINGS_TABLE) {
        if (s.portalEmails === 'no-row' || s.portalEmails === undefined) return { Items: [] }
        return { Items: [{ settingsKey: 'GLOBAL', portalEmailsPaused: !s.portalEmails }] }
      }

      if (table === INVITE_TABLE) {
        const decoys = s.inviteDecoyPages ?? 0
        if (invitePage < decoys) {
          invitePage++
          // A page the filter matched nothing on, with more rows behind it.
          return { Items: [], LastEvaluatedKey: { id: `cursor-${invitePage}` } }
        }
        return { Items: s.invite ? [s.invite] : [] }
      }

      if (table === DRIVER_TABLE) return { Items: s.driver ? [s.driver] : [] }
      return undefined
    })

  const ses = vi.spyOn(SESv2Client.prototype, 'send').mockResolvedValue(undefined as never)
  return { ddb, ses }
}

function sentEmail(ses: MockInstance): { to: string; subject: string; body: string } {
  const cmd = ses.mock.calls[0][0] as SendEmailCommand
  const input = cmd.input
  return {
    to: (input.Destination?.ToAddresses ?? [])[0] ?? '',
    subject: input.Content?.Simple?.Subject?.Data ?? '',
    body: input.Content?.Simple?.Body?.Text?.Data ?? '',
  }
}

const INVITE = { id: 'inv-1', driverId: 'drv-1', email: 'roy@example.com', token: 'tok-abc' }
const DRIVER = { id: 'drv-1', name: 'Roy Workman', email: 'roy@example.com' }

afterEach(() => vi.restoreAllMocks())

describe('appInvite', () => {
  let handler: Handler
  beforeEach(async () => { handler = await loadHandler() })

  it('sends even while portal emails are paused', async () => {
    // Paused is the DEFAULT. If the pause applied here, the button would do nothing
    // and still look like it worked.
    const { ses } = mockAws({ portalEmails: 'no-row', invite: INVITE, driver: DRIVER })

    const res = await handler({ arguments: { type: 'appInvite', inviteId: 'inv-1' } })

    expect(res).toEqual({ sent: true, to: 'roy@example.com' })
    expect(ses).toHaveBeenCalledTimes(1)
  })

  it('links to the signup page with the email prefilled, not the hiring portal', async () => {
    const { ses } = mockAws({ invite: INVITE, driver: DRIVER })

    await handler({ arguments: { type: 'appInvite', inviteId: 'inv-1' } })

    const { to, subject, body } = sentEmail(ses)
    expect(to).toBe('roy@example.com')
    expect(subject).toBe('Set up your Ivan Cartage driver sign-in')
    expect(body).toContain(`${BASE}/driver/signup?email=roy%40example.com`)
    expect(body).not.toContain('/onboard/')
    expect(body).toContain('Hi Roy,')
  })

  it('reports no-recipient instead of sending to nobody', async () => {
    const { ses } = mockAws({ invite: undefined, driver: undefined })

    const res = await handler({ arguments: { type: 'appInvite', inviteId: 'missing' } })

    expect(res).toEqual({ sent: false, error: 'no-recipient' })
    expect(ses).not.toHaveBeenCalled()
  })

  it('finds an invite that is not on the first scanned page', async () => {
    // DynamoDB applies a FilterExpression after reading a page, so a single-page scan
    // returns "not found" for a row that exists on any busy table.
    const { ses } = mockAws({ invite: INVITE, driver: DRIVER, inviteDecoyPages: 3 })

    const res = await handler({ arguments: { type: 'appInvite', inviteId: 'inv-1' } })

    expect(res).toEqual({ sent: true, to: 'roy@example.com' })
    expect(sentEmail(ses).to).toBe('roy@example.com')
  })
})

describe('the hiring invite is unchanged', () => {
  let handler: Handler
  beforeEach(async () => { handler = await loadHandler() })

  it('is still held back by the pause switch', async () => {
    const { ses } = mockAws({ portalEmails: false, invite: INVITE, driver: DRIVER })

    const res = await handler({ arguments: { type: 'invite', inviteId: 'inv-1' } })

    expect(res).toEqual({ sent: false, paused: true })
    expect(ses).not.toHaveBeenCalled()
  })

  it('still points at the tokenized hiring portal when emails are live', async () => {
    const { ses } = mockAws({ portalEmails: true, invite: INVITE, driver: DRIVER })

    await handler({ arguments: { type: 'invite', inviteId: 'inv-1' } })

    expect(sentEmail(ses).body).toContain(`${BASE}/onboard/tok-abc`)
  })
})
