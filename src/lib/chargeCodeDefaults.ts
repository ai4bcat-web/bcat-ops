/**
 * The accessorial charge types a freight shipment normally needs, so nobody has to type them in
 * before using them (Ryne 2026-11-11). They are merged under whatever the company has saved in
 * Settings > Charge codes: a saved code with the same name wins, and every saved code stays.
 * Codes are upper case because the Rates picker upper-cases what is typed before it matches.
 * No default carries an amount: the amount is the price of the job, not a property of the type.
 */
import type { ChargeCodeDef } from '@/types/tms'

const def = (code: string, label: string, category: string, calculatedBy: ChargeCodeDef['calculatedBy'] = 'FLAT'): ChargeCodeDef => ({
  code, label, category, calculatedBy, defaultAmountCents: null, visibility: 'CUSTOMER',
})

export const DEFAULT_CHARGE_CODES: readonly ChargeCodeDef[] = [
  // Time on site
  def('DETENTION', 'Detention', 'Time'),
  def('LAYOVER', 'Layover', 'Time'),
  def('WAIT', 'Wait time', 'Time'),
  def('DRYRUN', 'Dry run', 'Time'),
  def('TONU', 'Truck ordered not used', 'Time'),
  def('REDELIVERY', 'Redelivery', 'Time'),
  // Handling at the dock
  def('LUMPER', 'Lumper', 'Handling'),
  def('LOADUNLOAD', 'Driver load / unload', 'Handling'),
  def('SORTSEG', 'Sort and segregate', 'Handling'),
  def('PALLETEX', 'Pallet exchange', 'Handling'),
  def('LIFTGATE', 'Liftgate', 'Handling'),
  def('INSIDEDEL', 'Inside delivery', 'Handling'),
  def('RESIDENTIAL', 'Residential delivery', 'Handling'),
  def('APPTFEE', 'Appointment fee', 'Handling'),
  def('SCALE', 'Scale ticket', 'Handling'),
  // Stops and routing
  def('STOPOFF', 'Extra stop', 'Routing'),
  def('DROPHOOK', 'Drop and hook', 'Routing'),
  def('DEADHEAD', 'Deadhead', 'Routing', 'PER_MILE'),
  def('BORDER', 'Border crossing', 'Routing'),
  def('TOLLS', 'Tolls', 'Routing'),
  def('ESCORT', 'Escort / pilot car', 'Routing'),
  // Equipment and freight
  def('TEAM', 'Team drivers', 'Equipment'),
  def('TARP', 'Tarp', 'Equipment'),
  def('TEMPCTL', 'Temperature control', 'Equipment'),
  def('HAZMAT', 'Hazmat', 'Equipment'),
  def('OVERSIZE', 'Oversize / overweight', 'Equipment'),
  def('HIGHVALUE', 'High value / insurance', 'Equipment'),
  def('WASHOUT', 'Trailer wash-out', 'Equipment'),
  // Port and rail
  def('CHASSIS', 'Chassis', 'Port'),
  def('PREPULL', 'Pre-pull', 'Port'),
  def('STORAGE', 'Storage', 'Port'),
  def('DEMURRAGE', 'Demurrage', 'Port'),
  // Surcharges
  def('EXPEDITE', 'Expedite / rush', 'Surcharge'),
  def('AFTERHOURS', 'After hours', 'Surcharge'),
  def('WEEKEND', 'Weekend / holiday', 'Surcharge'),
]

/** What the company saved, then every default whose code it has not saved (compared ignoring case). */
export function withDefaultChargeCodes(saved: readonly ChargeCodeDef[] | null | undefined): ChargeCodeDef[] {
  const have = new Set((saved ?? []).map((c) => String(c.code).trim().toUpperCase()))
  return [...(saved ?? []), ...DEFAULT_CHARGE_CODES.filter((d) => !have.has(d.code)).map((d) => ({ ...d }))]
}
