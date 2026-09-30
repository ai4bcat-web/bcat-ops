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
): Record<string, { S?: string; BOOL?: boolean }> {
  const item: Record<string, { S?: string; BOOL?: boolean }> = {
    id: { S: id },
  }
  if (email !== null) item.email = { S: email }
  if (typeof active === 'boolean') item.active = { BOOL: active }
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
    sendSpy.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        if (command.input.TableName === DRIVER_TABLE) {
          return { Items: [driverItem('drv-3', 'local@bcatcorp.com', true)] }
        }
        if (command.input.TableName === PAY_SETTING_TABLE) {
          return {
            Items: [
              paySettingItem('drv-3', 'local@bcatcorp.com', true, 'LOCAL'),
            ],
          }
        }
      }
      return undefined
    })

    await expect(handler(signupEvent('local@bcatcorp.com'))).rejects.toThrow(
      'No driver record matches this email. Contact dispatch.',
    )
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
