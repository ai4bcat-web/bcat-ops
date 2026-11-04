/**
 * Dev-stack schedule guard. On the long-lived `dev` stack every EventBridge rule is DISABLED so
 * nothing acts on the outside world by itself. Exactly three rules are exempt: the nightly
 * DynamoDB export and its completion check, which read dev tables and write the dev DataSafety
 * bucket and nothing external, and the dashboard rollup sweep, which reads dev tables and
 * writes only its own DashboardRollup table. The match is on the exact construct id of the
 * rule's L2 scope — a prefix, a different case or an empty id stays disabled.
 */
export const KEEP_ENABLED_ON_DEV: ReadonlySet<string> = new Set([
  'DataSafetyNightlyExportRule',
  'DataSafetyNightlyCheckRule',
  'DashboardRollupSweepRule',
])

/** The state the dev guard leaves a rule in, given the id of the construct that owns the CfnRule. */
export function devRuleState(scopeId: string | undefined): 'ENABLED' | 'DISABLED' {
  return scopeId !== undefined && KEEP_ENABLED_ON_DEV.has(scopeId) ? 'ENABLED' : 'DISABLED'
}

/**
 * Dev-stack outbound mail guard. Dev used to deny `ses:*` outright, so nothing could ever be
 * proven end to end. The account has SES production access, so the dev guard now denies every
 * send that has a recipient outside the one test mailbox (`ai4bcat@gmail.com`, plus its
 * `+tag` aliases, which the rate con's tracking/sender Cc and the per-shipment reply address
 * use). The condition is `ForAnyValue:StringNotLike ses:Recipients`: ONE stray To/Cc/Bcc
 * address anywhere in the message refuses the whole send. A real customer or carrier can
 * therefore never be mailed from dev, whatever the data says.
 */
export const DEV_SES_ALLOWED_RECIPIENT_PATTERNS: readonly string[] = ['ai4bcat@gmail.com', 'ai4bcat+*@gmail.com']

export interface DevSesDeny {
  actions: string[]
  conditions: Record<string, Record<string, string[]>>
}

export function devSesDeny(): DevSesDeny {
  return {
    actions: ['ses:*'],
    conditions: { 'ForAnyValue:StringNotLike': { 'ses:Recipients': [...DEV_SES_ALLOWED_RECIPIENT_PATTERNS] } },
  }
}

/** Mirror of the IAM condition, for the tests and the harness: would dev let this address through? */
export function devSesAllowsRecipient(address: string): boolean {
  const a = address.trim()
  return DEV_SES_ALLOWED_RECIPIENT_PATTERNS.some((p) => {
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    return re.test(a)
  })
}
