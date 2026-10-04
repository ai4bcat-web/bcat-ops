/**
 * Driver-app launch scope. Widening later means editing this one array.
 *
 * LOCAL is Ivan's own fleet. They reached the app when Ivan paperwork shipped: they see
 * their week's deliveries and send the paperwork for them, but no pay — their page shows
 * no rate and no deductions, because Ivan's drivers are not settled a percentage the way
 * the owner operators are. `driverProgram` is what decides which page they land on.
 */

export const ELIGIBLE_PAY_GROUPS = ['AMAZON', 'OWNER_OPERATOR', 'LOCAL'] as const

type EligiblePayGroup = (typeof ELIGIBLE_PAY_GROUPS)[number]

/**
 * Treat a null/missing pay group as Amazon, matching the staff-side default.
 */
export function isEligiblePayGroup(payGroup: string | null | undefined): payGroup is EligiblePayGroup {
  const effective = payGroup ?? 'AMAZON'
  return (ELIGIBLE_PAY_GROUPS as readonly string[]).includes(effective)
}
