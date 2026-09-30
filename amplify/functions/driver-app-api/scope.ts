/**
 * Driver-app launch scope. Widening later means editing this one array.
 */

export const ELIGIBLE_PAY_GROUPS = ['AMAZON', 'OWNER_OPERATOR'] as const

type EligiblePayGroup = (typeof ELIGIBLE_PAY_GROUPS)[number]

/**
 * Treat a null/missing pay group as Amazon, matching the staff-side default.
 */
export function isEligiblePayGroup(payGroup: string | null | undefined): payGroup is EligiblePayGroup {
  const effective = payGroup ?? 'AMAZON'
  return (ELIGIBLE_PAY_GROUPS as readonly string[]).includes(effective)
}
