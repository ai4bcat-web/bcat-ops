/**
 * Dev-stack schedule guard. On the long-lived `dev` stack every EventBridge rule is DISABLED so
 * nothing acts on the outside world by itself. Exactly two rules are exempt: the nightly
 * DynamoDB export and its completion check, which read dev tables and write the dev DataSafety
 * bucket and nothing external. The match is on the exact construct id of the rule's L2 scope —
 * a prefix, a different case or an empty id stays disabled.
 */
export const KEEP_ENABLED_ON_DEV: ReadonlySet<string> = new Set([
  'DataSafetyNightlyExportRule',
  'DataSafetyNightlyCheckRule',
])

/** The state the dev guard leaves a rule in, given the id of the construct that owns the CfnRule. */
export function devRuleState(scopeId: string | undefined): 'ENABLED' | 'DISABLED' {
  return scopeId !== undefined && KEEP_ENABLED_ON_DEV.has(scopeId) ? 'ENABLED' : 'DISABLED'
}
