/**
 * An admin opening a driver's app as that driver.
 *
 * Two pools reach this Lambda and they are not interchangeable. These pin the three things
 * that make accepting a staff token here safe at all — because each of them is one edit
 * away from quietly not holding, and the failure mode is an admin acting as a driver with
 * the driver's name on the record.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env.DRIVER_USER_POOL_ID = 'us-east-1_driverpool'
  process.env.DRIVER_USER_POOL_CLIENT_ID = 'driver-client'
  process.env.STAFF_USER_POOL_ID = 'us-east-1_staffpool'
  process.env.STAFF_USER_POOL_CLIENT_ID = 'staff-client'
  process.env.DRIVER_TABLE_NAME = 'Driver-test'
  process.env.DRIVER_PAY_SETTING_TABLE_NAME = 'DriverPaySetting-test'
  process.env.DRIVER_SUBMISSION_TABLE_NAME = 'DriverSubmission-test'
  process.env.DRIVER_SUBMISSION_DOC_TABLE_NAME = 'DriverSubmissionDoc-test'
  process.env.AMAZON_TRIP_TABLE_NAME = 'AmazonTrip-test'
  process.env.DRIVER_PAY_DEDUCTION_TABLE_NAME = 'DriverPayDeduction-test'
  process.env.DRIVER_PAY_CREDIT_TABLE_NAME = 'DriverPayCredit-test'
  process.env.FUEL_TRANSACTION_TABLE_NAME = 'FuelTransaction-test'
  process.env.LOAD_TABLE_NAME = 'Load-test'
  process.env.BUCKET_NAME = 'bucket-test'
  process.env.AUDIT_LOG_TABLE_NAME = 'AuditLog-test'
})

/** Which pool a token belongs to, so using the wrong verifier is visible. */
const staffVerify = vi.hoisted(() => vi.fn())
const driverVerify = vi.hoisted(() => vi.fn())
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: ({ userPoolId }: { userPoolId: string }) => ({
      verify: userPoolId.includes('staff') ? staffVerify : driverVerify,
    }),
  },
}))

const send = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/lib-dynamodb', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  DynamoDBDocumentClient: { from: () => ({ send }) },
}))

let handler: typeof import('./handler').handler
let mayImpersonate: typeof import('./handler').mayImpersonate

beforeAll(async () => {
  const mod = await import('./handler')
  handler = mod.handler
  mayImpersonate = mod.mayImpersonate
})

const DRIVER = { id: 'drv-1', name: 'Ryne Test', email: 'ryne@bcatcorp.com', active: true }
const SETTING = { driverId: 'drv-1', payGroup: 'OWNER_OPERATOR', active: true, payPercent: 0.88 }

beforeEach(() => {
  vi.clearAllMocks()
  staffVerify.mockResolvedValue({ email: 'ryne@bcatcorp.com', email_verified: true })
  driverVerify.mockRejectedValue(new Error('not a driver token'))
  send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name
    if (name === 'GetCommand') return { Item: DRIVER }
    if (name === 'ScanCommand') {
      return { Items: String(cmd.input.TableName).includes('PaySetting') ? [SETTING] : [DRIVER] }
    }
    return {}
  })
})

const event = (method: string, path: string, headers: Record<string, string>) => ({
  rawPath: path,
  requestContext: { http: { method } },
  headers: { authorization: 'Bearer tok', ...headers },
  queryStringParameters: { week: '2026-09-27' },
})

const AS_DRIVER = { 'x-bcat-impersonate-driver': 'drv-1' }

describe('impersonation', () => {
  it('only consults the staff pool when the caller asks for it', async () => {
    // Without the header a staff token is still just an invalid driver token.
    await handler(event('GET', '/me', {}) as never)
    expect(driverVerify).toHaveBeenCalled()
    expect(staffVerify).not.toHaveBeenCalled()
  })

  it('serves the driver when an admin asks, using the staff pool', async () => {
    const res = await handler(event('GET', '/me', AS_DRIVER) as never)
    expect(staffVerify).toHaveBeenCalled()
    expect(driverVerify).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).driverId).toBe('drv-1')
  })

  it('refuses a staff member who is not an admin', async () => {
    // Being able to sign in to the office app is not permission to read someone's pay.
    staffVerify.mockResolvedValue({ email: 'kel@bcatcorp.com', email_verified: true })
    const res = await handler(event('GET', '/me', AS_DRIVER) as never)
    expect(res.statusCode).toBe(403)
  })

  it('refuses a DRIVER token carrying the header', async () => {
    // Or any driver could read any other driver's pay by adding one header.
    staffVerify.mockRejectedValue(new Error('token is not from this pool'))
    const res = await handler(event('GET', '/me', AS_DRIVER) as never)
    expect(res.statusCode).toBe(401)
  })

  it('refuses every write while impersonating', async () => {
    /*
     * The line that makes this safe to have. Without it an admin could upload or remove a
     * driver's POD wearing their identity, and the submission, the email and the
     * settlement would all say the driver did it.
     */
    for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
      const res = await handler(event(method, '/submissions', AS_DRIVER) as never)
      expect(res.statusCode, `${method} should be refused`).toBe(403)
      expect(JSON.parse(res.body).error).toMatch(/viewing this driver app/)
    }
  })

  it('still lets the driver themselves write', async () => {
    // The read-only rule is about impersonation, not about the driver.
    driverVerify.mockResolvedValue({ email: 'ryne@bcatcorp.com', email_verified: true })
    const res = await handler(event('POST', '/submissions', {}) as never)
    expect(res.statusCode).not.toBe(403)
  })

  it('writes an audit row before serving the request', async () => {
    await handler(event('GET', '/me', AS_DRIVER) as never)
    const put = send.mock.calls
      .map(([c]) => c as { constructor: { name: string }; input: Record<string, unknown> })
      .find((c) => c.constructor.name === 'PutCommand' && String(c.input.TableName).includes('AuditLog'))
    expect(put, 'no audit row was written').toBeDefined()
    const item = put!.input.Item as Record<string, unknown>
    expect(item.action).toBe('IMPERSONATE_DRIVER_APP')
    expect(item.user).toBe('ryne@bcatcorp.com')
    expect(item.entityId).toBe('drv-1')
  })

  it('serves the request even if the audit write fails, and says so loudly', async () => {
    // Losing the view is worse than losing one audit row; CloudWatch keeps the record.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name
      if (name === 'PutCommand') throw new Error('throttled')
      if (name === 'GetCommand') return { Item: DRIVER }
      if (name === 'ScanCommand') {
        return { Items: String(cmd.input.TableName).includes('PaySetting') ? [SETTING] : [DRIVER] }
      }
      return {}
    })
    const res = await handler(event('GET', '/me', AS_DRIVER) as never)
    expect(res.statusCode).toBe(200)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  /*
   * Ivan's drivers have no DriverPaySetting — nobody creates one for a driver who is not
   * settled a percentage. Both paths required one, so every Ivan driver was refused with
   * "Driver has no active pay setting": an admin pressing View as driver on Ivan Paperwork
   * got nothing, and the driver themselves could not sign in either.
   */
  describe('a driver on the paperwork program, who has no pay setting', () => {
    const IVAN = { id: 'drv-ivan', name: 'Charles Best', email: 'charles@bcatcorp.com', active: true, fleetGroup: 'LOCAL' }

    beforeEach(() => {
      send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name
        if (name === 'GetCommand') return { Item: IVAN }
        if (name === 'ScanCommand') {
          const t = String(cmd.input.TableName)
          // No pay setting exists for them. That is the normal state, not a mistake.
          if (t.includes('PaySetting')) return { Items: [] }
          if (t.includes('Driver-')) return { Items: [IVAN] }
          return { Items: [] }
        }
        return {}
      })
    })

    it('can be viewed by an admin', async () => {
      const res = await handler(event('GET', '/paperwork', { 'x-bcat-impersonate-driver': 'drv-ivan' }))
      expect(res.statusCode).toBe(200)
    })

    it('resolves on their own token too, so they can sign in', async () => {
      driverVerify.mockResolvedValue({ email: 'charles@bcatcorp.com', email_verified: true })
      const res = await handler(event('GET', '/me', {}))
      expect(res.statusCode).toBe(200)
      const me = JSON.parse(res.body)
      expect(me.driverId).toBe('drv-ivan')
      expect(me.program).toBe('PAPERWORK')
    })

    it('is refused a settlement rather than shown a $0 check', async () => {
      /*
       * The synthesised setting carries 0%. Computing a settlement from it would render a
       * real-looking $0.00 cheque, so the endpoint declines instead.
       */
      driverVerify.mockResolvedValue({ email: 'charles@bcatcorp.com', email_verified: true })
      const res = await handler(event('GET', '/settlement', {}))
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).error).toMatch(/paperwork, not a settlement/i)
    })

    it('still cannot be written to while impersonated', async () => {
      const res = await handler(event('POST', '/paperwork/time', { 'x-bcat-impersonate-driver': 'drv-ivan' }))
      expect(res.statusCode).toBe(403)
    })
  })

  it('names who may do it', () => {
    expect(mayImpersonate('ryne@bcatcorp.com')).toBe(true)
    expect(mayImpersonate('RYNE@BCATCORP.COM ')).toBe(true)
    expect(mayImpersonate('kel@bcatcorp.com')).toBe(false)
    expect(mayImpersonate('')).toBe(false)
  })
})
