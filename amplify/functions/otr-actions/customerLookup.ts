/** OTR's broker-check reply, read as "who is this MC" for the New Customer dialog. */
export interface CustomerLookupResult {
  found: boolean
  mcNumber: string
  name: string | null
  decision: string
  noBuy: boolean
  otrId: string | null
  message: string
}

export function customerLookupFrom(
  mc: string,
  check: { decision: string; message: string; brokerName: string | null; raw: unknown },
): CustomerLookupResult {
  const raw = (check.raw && typeof check.raw === 'object' ? check.raw : {}) as Record<string, unknown>
  const lower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]))
  const rawMc = lower.get('mcnumber')
  const otrId = lower.get('id')
  const found = check.decision !== 'NOT FOUND'
  return {
    found,
    mcNumber: typeof rawMc === 'string' && rawMc.trim() ? rawMc.trim() : typeof rawMc === 'number' ? String(rawMc) : mc,
    name: check.brokerName,
    decision: check.decision,
    noBuy: check.decision === 'NO BUY',
    otrId: otrId == null ? null : String(otrId),
    message: found ? check.message : `OTR has no customer with MC ${mc}`,
  }
}

