import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'
import type { PreSignUpTriggerEvent } from 'aws-lambda'
import { handler } from './handler'

const DRIVER_TABLE = 'DriverTestTable'
const PAY_SETTING_TABLE = 'DriverPaySettingTestTable'

function driverItem(
  id: string,
  email: string | null,
  active: boolean | undefined,
  fleet?: { fleetGroup?: string; driverType?: string },
): Record<string, { S?: string; BOOL?: boolean }> {
  const item: Record<string, { S?: string; BOOL?: boolean }> = {
    id: { S: id },
  }
  if (email !== null) item.email = { S: email }
  if (typeof active === 'boolean') item.active = { BOOL: active }
  if (fleet?.fleetGroup) item.fleetGroup = { S: fleet.fleetGroup }
  if (fleet?.driverType) item.driverType = { S: fleet.driverType }
  return item
}

function paySettingItem(
  driverId: string,
  email: string | null,
  active: boolean | undefined,
  payGroup: string,
): Record<string, { S?: string; BOOL?: boolean }> {
  const item: Record<string, { S?: string; BOOL?: boolean }> = {
    driverId: { S: driverId },
    payGroup: { S: payGroup },
  }
  if (email !== null) item.email = { S: email }
  if (typeof active === 'boolean') item.active = { BOOL: active }
  return item
}

function signupEvent(email: string): PreSignUpTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_test',
    triggerSource: 'PreSignUp_SignUp',
    userName: 'test-user',
    callerContext: {
      awsSdkVersion: '1',
      clientId: 'test-client',
    },
    request: {
      userAttributes: {
        email,
        email_verified: 'false',
      },
      validationData: {},
      clientMetadata: {},
    },
    response: {
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    },
  }
}

describe('driver-signup-gate handler', () => {
  let sendSpy: MockInstance

  beforeEach(() => {
    process.env.DRIVER_TABLE_NAME = DRIVER_TABLE
    process.env.DRIVER_PAY_SETTING_TABLE_NAME = PAY_SETTING_TABLE
    sendSpy = vi
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockReset()
      .mockImplementation(async (command) => {
        if (command instanceof ScanCommand) {
          if (command.input.TableName === DRIVER_TABLE) {
            return { Items: [] }
          }
          if (command.input.TableName === PAY_SETTING_TABLE) {
            return { Items: [] }
          }
        }
        return undefined
      })
  })

  it('allows an eligible active Amazon driver', async () => {
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-1', 'ivan@bcatcorp.com', true)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [paySettingItem('drv-1', 'ivan@bcatcorp.com', true, 'AMAZON')],
          }
        }
      }
      return undefined
    })

    const event = signupEvent('IVAN@bcatcorp.com')
    await expect(handler(event)).resolves.toBe(event)
  })

  it('rejects an unknown email', async () => {
    await expect(handler(signupEvent('unknown@example.com'))).rejects.toThrow(
      'No driver record matches this email. Contact dispatch.',
    )
  })

  it('rejects an inactive driver', async () => {
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-2', 'inactive@bcatcorp.com', false)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [
              paySettingItem('drv-2', 'inactive@bcatcorp.com', true, 'AMAZON'),
            ],
          }
        }
      }
      return undefined
    })

    await expect(handler(signupEvent('inactive@bcatcorp.com'))).rejects.toThrow(
      'No driver record matches this email. Contact dispatch.',
    )
  })

  it('admits an owner operator, who signs up through this same gate', async () => {
    // The gate used to keep its own ['AMAZON'] list; widening the driver API alone left
    // owner operators unable to register at all.
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-oo', 'oo@bcatcorp.com', true)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return { Items: [paySettingItem('drv-oo', 'oo@bcatcorp.com', true, 'OWNER_OPERATOR')] }
        }
      }
      return undefined
    })

    await expect(handler(signupEvent('oo@bcatcorp.com'))).resolves.toBeDefined()
  })

  it('rejects a pay group that is not on the driver-app roster', async () => {
    // BOX_TRUCK has no page in the driver app, so it is still off the roster. LOCAL used to
    // be this test's example and is now allowed — see the next test.
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-3', 'box@bcatcorp.com', true)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [
              paySettingItem('drv-3', 'box@bcatcorp.com', true, 'BOX_TRUCK'),
            ],
          }
        }
      }
      return undefined
    })

    await expect(handler(signupEvent('box@bcatcorp.com'))).rejects.toThrow(
      'No driver record matches this email. Contact dispatch.',
    )
  })

  it('lets one of Ivan’s own drivers create an account', async () => {
    /*
     * LOCAL is Ivan's fleet. They joined the roster when Ivan paperwork shipped: the invite
     * and sign-up path is the same one the owner operators use, and this gate is what
     * decides who may take it. Without LOCAL here an invited Ivan driver is told no driver
     * record matches their email.
     */
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-local', 'local@bcatcorp.com', true)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return { Items: [paySettingItem('drv-local', 'local@bcatcorp.com', true, 'LOCAL')] }
        }
      }
      return undefined
    })

    await expect(handler(signupEvent('local@bcatcorp.com'))).resolves.toBeDefined()
  })

  it('matches case-insensitively against DriverPaySetting email when Driver email is absent', async () => {
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return {
            Items: [driverItem('drv-4', null, true)],
          }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [
              paySettingItem('drv-4', 'PAYSETTING@bcatcorp.com', true, 'AMAZON'),
            ],
          }
        }
      }
      return undefined
    })

    const event = signupEvent('paysetting@bcatcorp.com')
    await expect(handler(event)).resolves.toBe(event)
  })

  it('allows an eligible driver when active attributes are absent (treated as active)', async () => {
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-5', 'missingactive@bcatcorp.com', undefined)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [
              paySettingItem('drv-5', 'missingactive@bcatcorp.com', undefined, 'AMAZON'),
            ],
          }
        }
      }
      return undefined
    })

    const event = signupEvent('missingactive@bcatcorp.com')
    await expect(handler(event)).resolves.toBe(event)
  })

  it('rejects a pay setting that is explicitly inactive', async () => {
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-6', 'inactive-setting@bcatcorp.com', true)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [
              paySettingItem('drv-6', 'inactive-setting@bcatcorp.com', false, 'AMAZON'),
            ],
          }
        }
      }
      return undefined
    })

    await expect(handler(signupEvent('inactive-setting@bcatcorp.com'))).rejects.toThrow(
      'No driver record matches this email. Contact dispatch.',
    )
  })
})

describe('Ivan drivers, who have no pay setting at all', () => {
  let sendSpy: MockInstance

  /** Only the Driver table has rows — which is the real shape for the Ivan fleet. */
  function onlyDrivers(items: Record<string, unknown>[]) {
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) return { Items: items }
        if (command.input.TableName === PAY_SETTING_TABLE) return { Items: [] }
      }
      return undefined
    })
  }

  beforeEach(() => {
    process.env.DRIVER_TABLE_NAME = DRIVER_TABLE
    process.env.DRIVER_PAY_SETTING_TABLE_NAME = PAY_SETTING_TABLE
    sendSpy = vi.spyOn(DynamoDBClient.prototype, 'send').mockReset()
  })

  it('lets a LOCAL driver sign up with no pay setting', async () => {
    /*
     * The live bug: Jason Smith's record sat there, active, with that exact address, and
     * the gate answered "No driver record matches this email" because nothing had ever
     * created a DriverPaySetting for him — nothing ever will, the Ivan app has no pay page.
     * All five Ivan drivers were locked out the same way.
     */
    onlyDrivers([
      driverItem('drv-ivan', 'mastermechanicjs22@gmail.com', true, { fleetGroup: 'LOCAL' }),
    ])
    await expect(handler(signupEvent('mastermechanicjs22@gmail.com'))).resolves.toBeDefined()
  })

  it('still refuses an inactive LOCAL driver', async () => {
    onlyDrivers([driverItem('drv-ivan', 'gone@x.com', false, { fleetGroup: 'LOCAL' })])
    await expect(handler(signupEvent('gone@x.com'))).rejects.toThrow(/No driver record matches/)
  })

  it('still refuses an unknown email', async () => {
    onlyDrivers([driverItem('drv-ivan', 'jason@x.com', true, { fleetGroup: 'LOCAL' })])
    await expect(handler(signupEvent('stranger@x.com'))).rejects.toThrow(/No driver record matches/)
  })

  it('does NOT let an unclassified driver through on a missing pay setting', async () => {
    /*
     * The fail-safe direction. driverProgramOf treats the unstated case as SETTLEMENT, so a
     * driver with no fleet and no pay setting is not silently granted an account — this is
     * the hole that "no setting means Ivan" would have opened.
     */
    onlyDrivers([driverItem('drv-x', 'mystery@x.com', true)])
    await expect(handler(signupEvent('mystery@x.com'))).rejects.toThrow(/No driver record matches/)
  })

  it('does NOT let an owner operator through on a missing pay setting', async () => {
    onlyDrivers([
      driverItem('drv-oo', 'oo@x.com', true, { fleetGroup: 'LOCAL', driverType: 'OWNER_OPERATOR' }),
    ])
    await expect(handler(signupEvent('oo@x.com'))).rejects.toThrow(/No driver record matches/)
  })

  it('does NOT let an Amazon driver through on a missing pay setting', async () => {
    onlyDrivers([driverItem('drv-az', 'az@x.com', true, { fleetGroup: 'AMAZON' })])
    await expect(handler(signupEvent('az@x.com'))).rejects.toThrow(/No driver record matches/)
  })
})
