/** The covered-carrier card's insurance lines (pure, so the card file only exports the component). */
import type { CarrierRecord, InsurancePolicyType } from '@/types/tms'

const POLICY_LABEL: Record<InsurancePolicyType, string> = {
  AUTO_LIABILITY: 'Auto liability',
  CARGO: 'Cargo',
  GENERAL_LIABILITY: 'General liability',
  WORKERS_COMP: 'Workers comp',
  OTHER: 'Other',
}
/** Policy dates are calendar days (MCP sends midnight UTC): read the date part, so 2027-06-01 never shows as 05/31. */
function policyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`

const POLICY_ORDER: InsurancePolicyType[] = ['AUTO_LIABILITY', 'CARGO', 'GENERAL_LIABILITY', 'WORKERS_COMP', 'OTHER']

/** "Auto liability $1,000,000 · active to 06/01/2027", or "missing" / "expired" — one line per policy type the gate cares about. */
export function insuranceLines(carrier: Pick<CarrierRecord, 'insurancePolicies'>, now: Date = new Date()): { type: InsurancePolicyType; label: string; text: string; tone: 'ok' | 'bad' }[] {
  const policies = carrier.insurancePolicies ?? []
  const lines: { type: InsurancePolicyType; label: string; text: string; tone: 'ok' | 'bad' }[] = []
  for (const type of POLICY_ORDER) {
    const p = policies.find((x) => x.type === type)
    if (!p) {
      if (type === 'AUTO_LIABILITY' || type === 'CARGO') lines.push({ type, label: POLICY_LABEL[type], text: 'not on file', tone: 'bad' })
      continue
    }
    const expired = p.expiresAt ? new Date(p.expiresAt) < now : false
    const limit = p.limitCents != null ? money(p.limitCents) : 'limit not on file'
    const until = p.expiresAt ? `${expired ? 'expired' : 'active to'} ${policyDate(p.expiresAt)}` : 'no expiry on file'
    lines.push({ type, label: POLICY_LABEL[type], text: `${limit} · ${until}`, tone: expired ? 'bad' : 'ok' })
  }
  return lines
}
