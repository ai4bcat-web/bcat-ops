/**
 * Load Review requirements — what a shipment must show before it is pushed into Load
 * Review and before Load Review releases it to billing. One pure module, imported
 * relatively by the Lambda and through `@/lib` by the browser, so the board's batch bar,
 * the push gate, the review release gate and REVIEW_LOAD cannot disagree.
 *
 * The list is per customer: `Customer.reviewRequirements` wins, then the org default
 * `TmsSettings.reviewRequirements`, then the built-in seven. An explicit empty list on
 * the customer means "nothing is required for this customer" (it is not a fallthrough);
 * null / absent falls through.
 */

export type ReviewRequirement =
  | 'revDivision'
  | 'referenceNumber'
  | 'podReceived'
  | 'rateConReceived'
  | 'salesRep'
  | 'revenueEntered'
  | 'expenseEntered'
  | 'profitEntered'

/** The built-in set, in the order failures are reported and the profile draws the boxes. */
export const REVIEW_REQUIREMENTS: readonly ReviewRequirement[] = [
  'revDivision',
  'referenceNumber',
  'podReceived',
  'rateConReceived',
  'salesRep',
  'revenueEntered',
  'expenseEntered',
  'profitEntered',
]

export const REVIEW_REQUIREMENT_LABELS: Record<ReviewRequirement, string> = {
  revDivision: 'Revenue division',
  referenceNumber: 'Reference #',
  podReceived: 'POD received',
  rateConReceived: 'RC received',
  salesRep: 'Sales rep',
  revenueEntered: 'Revenue entered',
  expenseEntered: 'Expense entered',
  profitEntered: 'Profit entered',
}

export const DEFAULT_REVIEW_REQUIREMENTS: readonly ReviewRequirement[] = REVIEW_REQUIREMENTS

/** Failure code per requirement. The first three keep the codes Load Review always used. */
export const REVIEW_REQUIREMENT_CODES: Record<ReviewRequirement, string> = {
  revDivision: 'REV_DIVISION_MISSING',
  referenceNumber: 'REFERENCE_NUMBER_MISSING',
  podReceived: 'POD_MISSING',
  rateConReceived: 'RATE_CON_MISSING',
  salesRep: 'SALES_REP_MISSING',
  revenueEntered: 'NO_CUSTOMER_CHARGES',
  expenseEntered: 'EXPENSE_MISSING',
  profitEntered: 'PROFIT_MISSING',
}

/** The sentence per failure (Load Review's three original sentences are unchanged). */
export const REVIEW_REQUIREMENT_MESSAGES: Record<ReviewRequirement, string> = {
  revDivision: 'Missing revenue division',
  referenceNumber: 'Missing reference #',
  podReceived: 'POD not received',
  rateConReceived: 'RC not received',
  salesRep: 'Missing sales rep',
  revenueEntered: 'No customer charges',
  expenseEntered: 'No expense entered',
  profitEntered: 'Profit not available (needs revenue and expense)',
}

/** What a caller reads off a shipment. Anything unknown is null / false: unknown fails. */
export interface ReviewFacts {
  revDivision?: string | null
  salesRepId?: string | null
  /** Any non-blank order reference (PO, BOL, customer reference, ...). */
  referenceNumber?: string | null
  podReceived?: boolean | null
  revenueCents?: number | null
  /** What the load costs: carrier charges or driver settlement. */
  expenseCents?: number | null
  /** Revenue minus expense once both are entered; null while either is missing. */
  profitCents?: number | null
  /**
   * An asset load (isAssetLoad): our own trucks earn the revenue and pay no carrier, so expense and profit are never
   * required. Only the customer rate (revenue) is (Ryne 2026-11-16).
   */
  assetLoad?: boolean | null
}

/** What isAssetLoad reads; every field optional so board rows, review rows and raw server rows all fit. */
export interface AssetLoadFacts {
  revDivision?: string | null
  assignmentType?: string | null
  /** Kinds of the live carrier assignments (OWN_ASSET / CARRIER). */
  legKinds?: readonly (string | null | undefined)[] | null
  carrierName?: string | null
  carrierNames?: readonly (string | null | undefined)[] | null
}

/**
 * The one test for an asset load (Ryne 2026-11-16): revenue division ASSETS (any subdivision), or our own fleet on the
 * assignment: an OWN_ASSET assignment, or an Ivan Cartage carrier (local drivers / owner operators / box trucks).
 * Import-free so the Lambda bundles it.
 */
export function isAssetLoad(row: AssetLoadFacts | null | undefined): boolean {
  if (!row) return false
  if (String(row.revDivision ?? '').trim().toUpperCase() === 'ASSETS') return true
  if (row.assignmentType === 'OWN_ASSET') return true
  if ((row.legKinds ?? []).includes('OWN_ASSET')) return true
  const ivan = (name: string | null | undefined) => /\bivan\s*cartage\b/i.test(name ?? '')
  return ivan(row.carrierName) || (row.carrierNames ?? []).some(ivan)
}

export interface ReviewFailure {
  requirement: ReviewRequirement
  code: string
  message: string
}

export interface ReviewEvaluation {
  ok: boolean
  failures: ReviewFailure[]
}

function isRequirement(value: unknown): value is ReviewRequirement {
  return typeof value === 'string' && (REVIEW_REQUIREMENTS as readonly string[]).includes(value)
}

/** Unknown strings are dropped, duplicates collapse, result is in canonical order. */
export function normalizeReviewRequirements(list: readonly unknown[]): ReviewRequirement[] {
  const chosen = new Set(list.filter(isRequirement))
  return REVIEW_REQUIREMENTS.filter((key) => chosen.has(key))
}

/**
 * Customer set overrides the org default, which overrides the built-in seven. Null,
 * undefined and non-arrays fall through; an array (even empty) is a decision.
 */
export function resolveReviewRequirements(
  customerList: readonly string[] | null | undefined,
  orgList: readonly string[] | null | undefined,
): ReviewRequirement[] {
  if (Array.isArray(customerList)) return normalizeReviewRequirements(customerList)
  if (Array.isArray(orgList)) return normalizeReviewRequirements(orgList)
  return [...DEFAULT_REVIEW_REQUIREMENTS]
}

function blank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0
}

function positive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** The one rule per requirement. */
function satisfied(requirement: ReviewRequirement, facts: ReviewFacts): boolean {
  switch (requirement) {
    case 'revDivision': return !blank(facts.revDivision)
    case 'salesRep': return !blank(facts.salesRepId)
    case 'referenceNumber': return !blank(facts.referenceNumber)
    case 'podReceived': return facts.podReceived === true
    // The release gate and the document gate own the rate confirmation itself; this requirement is the per-customer
    // switch for whether it is asked for at all (see docsNotRequiredFor), so it never fails on its own.
    case 'rateConReceived': return true
    case 'revenueEntered': return positive(facts.revenueCents)
    case 'expenseEntered': return facts.assetLoad === true || positive(facts.expenseCents)
    case 'profitEntered': return facts.assetLoad === true || (typeof facts.profitCents === 'number' && Number.isFinite(facts.profitCents))
  }
}

/** Profit from revenue and expense, null until both are entered. Shared by client and server. */
export function profitFromFacts(revenueCents: number | null | undefined, expenseCents: number | null | undefined): number | null {
  return positive(revenueCents) && positive(expenseCents) ? (revenueCents as number) - (expenseCents as number) : null
}

export function evaluateReviewRequirements(
  requirements: readonly ReviewRequirement[],
  facts: ReviewFacts,
): ReviewEvaluation {
  const failures: ReviewFailure[] = []
  for (const requirement of REVIEW_REQUIREMENTS) {
    if (!requirements.includes(requirement) || satisfied(requirement, facts)) continue
    failures.push({
      requirement,
      code: REVIEW_REQUIREMENT_CODES[requirement],
      message: REVIEW_REQUIREMENT_MESSAGES[requirement],
    })
  }
  return { ok: failures.length === 0, failures }
}

/** The most rows one batch may carry. Server and board share it. */
export const MAX_REVIEW_BATCH = 9

export function batchCapMessage(): string {
  return `A batch holds at most ${MAX_REVIEW_BATCH} shipments. Deselect one to add another.`
}

/**
 * The documents a customer does not need to invoice (Ryne 2026-11-15: AUTO SHIPPER needs no POD or RC), read from the
 * same per-customer Load Review list: unticking "POD received" or "RC received" drops that document from the release
 * gate, the document gate, Load Review and the board. OTR's own document rules (otrInvoice.ts) are separate and still
 * apply to a factored load.
 */
export function docsNotRequiredFor(requirements: readonly ReviewRequirement[]): ('POD' | 'RATE_CON')[] {
  const out: ('POD' | 'RATE_CON')[] = []
  if (!requirements.includes('podReceived')) out.push('POD')
  if (!requirements.includes('rateConReceived')) out.push('RATE_CON')
  return out
}

/**
 * The same, straight from the customer row and the org settings row (either may be absent).
 *
 * A customer we factor can never waive them: OTR will not buy an invoice without the POD and the rate confirmation
 * (assembleOtrInvoice's missingDocuments), so Load Review must hold the load until both are on file (Ryne 2026-11-16).
 */
export function customerDocsNotRequired(
  customer: { reviewRequirements?: readonly (string | null)[] | null; billingMethod?: string | null; factored?: boolean | null } | null | undefined,
  settings: { reviewRequirements?: readonly (string | null)[] | null } | null | undefined,
): ('POD' | 'RATE_CON')[] {
  if (customerFactorsForOtr(customer)) return []
  const own = Array.isArray(customer?.reviewRequirements) ? (customer.reviewRequirements.filter((v): v is string => typeof v === 'string')) : null
  const org = Array.isArray(settings?.reviewRequirements) ? (settings.reviewRequirements.filter((v): v is string => typeof v === 'string')) : null
  return docsNotRequiredFor(resolveReviewRequirements(own, org))
}

/** Billed through the factor (isFactorBilled's rule, restated here so this module stays import-free for the Lambda bundle). */
export function customerFactorsForOtr(customer: { billingMethod?: string | null; factored?: boolean | null } | null | undefined): boolean {
  if (!customer) return false
  if (customer.billingMethod === 'MANUAL') return false
  return customer.billingMethod === 'FACTOR' || customer.factored === true
}
