/**
 * Which app a driver gets: a settlement, or paperwork only.
 *
 * Two fleets use the driver app for opposite reasons. An owner operator is paid a
 * percentage of the freight, so their page IS a settlement — rates, deductions, a check
 * amount. Ivan's own drivers are employees dispatched off the calendar; they open the app
 * to see what they are delivering this week and to send the paperwork for it. Showing them
 * a rate would disclose what the load pays, and showing deductions would invent a
 * settlement that does not exist.
 *
 * THE DEFAULT IS THE SETTLEMENT, and that asymmetry is deliberate.
 *
 * A first version of this derived the answer the way the dispatch board's `driverGroupOf`
 * does — anyone not marked an owner operator is Ivan's. On the board that is the safe
 * reading. Here it is the dangerous one: `fleetGroup` and `driverType` are both optional,
 * several live owner operators carry neither, and treating a blank record as Ivan's would
 * have taken a working driver's settlement away and shown them a page with no pay on it.
 * The pipeline's own test for GET /me caught exactly that.
 *
 * So PAPERWORK requires positive evidence from one of the three fields that can carry it.
 * Anything unstated keeps the settlement, which is the behaviour every existing driver
 * already has.
 */
export type DriverProgram = 'SETTLEMENT' | 'PAPERWORK'

export interface ProgramInputs {
  fleetGroup?: string | null
  driverType?: string | null
  /** DriverPaySetting.payGroup. 'LOCAL' is Ivan's fleet. */
  payGroup?: string | null
  /** Staff override: this driver uses the Ivan app whatever their fleet. */
  ivanApp?: boolean | null
  /** Staff override for the Hours tab; null = decided by fleet. */
  timeClock?: boolean | null
}

export function driverProgramOf(driver: ProgramInputs): DriverProgram {
  // Staff said so: anyone can be put on the Ivan app regardless of fleet.
  if (driver.ivanApp === true) return 'PAPERWORK'
  // Box truck drivers run the Ivan paperwork app too (no settlement, no clock by default).
  if (driver.fleetGroup === 'BOX_TRUCK') return 'PAPERWORK'
  // Either field naming an owner operator settles it, as on the dispatch board.
  if (driver.fleetGroup === 'AMAZON') return 'SETTLEMENT'
  if (driver.driverType === 'OWNER_OPERATOR') return 'SETTLEMENT'

  // Positive evidence of Ivan's own fleet, from the driver record or the pay setting.
  if (driver.fleetGroup === 'LOCAL') return 'PAPERWORK'
  if (driver.payGroup === 'LOCAL') return 'PAPERWORK'

  // Unstated: keep the settlement. Never silently remove someone's pay page.
  return 'SETTLEMENT'
}

/** What the driver app calls the tab and the page for each program. */
export const PROGRAM_TITLE: Record<DriverProgram, string> = {
  SETTLEMENT: 'Settlement',
  PAPERWORK: 'Paperwork',
}

/**
 * Does this driver punch a clock in the app? Ivan's own local drivers do; box truck
 * drivers (on the Ivan app without a clock) and owner operators do not, unless staff
 * flip the switch on their file.
 */
export function timeClockFor(driver: ProgramInputs): boolean {
  if (driver.timeClock === true || driver.timeClock === false) return driver.timeClock
  return driver.fleetGroup === 'LOCAL' || (driver.fleetGroup == null && driver.payGroup === 'LOCAL')
}
