import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'
import { unmarshall } from '@aws-sdk/util-dynamodb'
import type { PreSignUpTriggerEvent } from 'aws-lambda'

// The gate and the driver API MUST agree on who may sign in; a second copy of this list
// silently locked owner operators out of the PWA once the API widened.
import { isEligiblePayGroup } from '../driver-app-api/scope'
// ...and the same drift locked Ivan drivers out, for the opposite reason: they have no
// DriverPaySetting at all, which the gate read as "not a driver". driverProgramOf is the
// one rule that says who is on paperwork rather than a settlement.
import { driverProgramOf } from '../../../src/lib/driverProgram'

// Deliberately names no pay group: owner operators register through this same gate.
const REJECTION_MESSAGE = 'No driver record matches this email. Contact dispatch.'

interface DriverItem {
  id: string
  email?: string | null
  active?: boolean | null
  // Needed to tell an Ivan driver from an owner operator when no pay setting exists.
  fleetGroup?: string | null
  driverType?: string | null
}

interface PaySettingItem {
  driverId: string
  email?: string | null
  active?: boolean | null
  payGroup?: string | null
}

const client = new DynamoDBClient({})

export const handler = async (
  event: PreSignUpTriggerEvent,
): Promise<PreSignUpTriggerEvent> => {
  const email = event.request.userAttributes.email?.toLowerCase().trim() ?? ''
  if (!email) {
    throw new Error(REJECTION_MESSAGE)
  }

  const driverTableName = process.env.DRIVER_TABLE_NAME
  const paySettingTableName = process.env.DRIVER_PAY_SETTING_TABLE_NAME
  if (!driverTableName || !paySettingTableName) {
    throw new Error('Driver signup gate is missing required table names')
  }

  const [driverResult, paySettingResult] = await Promise.all([
    client.send(
      new ScanCommand({
        TableName: driverTableName,
        ProjectionExpression: 'id, email, active, fleetGroup, driverType',
      }),
    ),
    client.send(
      new ScanCommand({
        TableName: paySettingTableName,
        ProjectionExpression: 'driverId, email, active, payGroup',
      }),
    ),
  ])

  const drivers = (driverResult.Items ?? []).map(
    (item) => unmarshall(item) as DriverItem,
  )
  const settings = (paySettingResult.Items ?? []).map(
    (item) => unmarshall(item) as PaySettingItem,
  )

  const driverMatch = drivers.find(
    (d) => d.email?.toLowerCase().trim() === email,
  )

  let driverId: string | undefined
  let driverActive = false
  let setting: PaySettingItem | undefined

  if (driverMatch) {
    // Driver.email takes precedence over DriverPaySetting.email.
    driverId = driverMatch.id
    driverActive = driverMatch.active !== false
    setting = settings.find(
      (s) => s.driverId === driverId && s.active !== false,
    )
  } else {
    // Fall back to matching an active pay setting by email, then verify its driver.
    setting = settings.find(
      (s) => s.email?.toLowerCase().trim() === email && s.active !== false,
    )
    if (setting) {
      const linkedDriver = drivers.find((d) => d.id === setting!.driverId)
      driverId = linkedDriver?.id
      driverActive = linkedDriver?.active !== false
    }
  }

  if (!driverId || !driverActive) {
    throw new Error(REJECTION_MESSAGE)
  }

  /*
   * An Ivan driver has no DriverPaySetting, and that is correct — their app has no pay page
   * to configure, so nothing ever creates one.
   *
   * The gate required one anyway, so every Ivan driver was told "no driver record matches
   * this email" while their record sat right there, active, with that exact address. The
   * driver API already solves this with syntheticPaperworkSetting; this is the same rule,
   * and it is the second time the gate and the API drifting has locked out a whole fleet —
   * the comment at the top of this file is about the first time.
   *
   * Deliberately asks driverProgramOf rather than testing fleetGroup here: a second copy of
   * that rule is exactly what caused this.
   */
  if (!setting) {
    const onPaperwork =
      driverMatch != null &&
      driverProgramOf({
        fleetGroup: driverMatch.fleetGroup,
        driverType: driverMatch.driverType,
        payGroup: null,
      }) === 'PAPERWORK'
    if (!onPaperwork) {
      throw new Error(REJECTION_MESSAGE)
    }
    return event
  }

  // isEligiblePayGroup keeps the null-payGroup default in one place.
  if (!isEligiblePayGroup(setting.payGroup)) {
    throw new Error(REJECTION_MESSAGE)
  }

  return event
}
