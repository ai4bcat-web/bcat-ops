/** The covered-carrier card's insurance chips (pure, so the card file only exports the component). */
import type { CarrierRecord, InsurancePolicyType } from '@/types/tms'

const POLICY_LABEL: Record<InsurancePolicyType, string> = {
  AUTO_LIABILITY: 'Auto',
  CARGO: 'Cargo',
  GENERAL_LIABILITY: 'GL',
  WORKERS_COMP: 'WC',
  OTHER: 'Other',
}
/** Policy dates are calendar days (MCP sends midnight UTC): read the date part, so 2027-06-01 never shows as 05/31. */
function policyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : iso
}
/** $1M, $100K, $750 — short enough for a chip. */
export function shortMoney(cents: number): string {
  const d = Math.round(cents / 100)
  const trim = (n: number) => String(Number(n.toFixed(1)))
  if (d >= 1_000_000) return `$${trim(d / 1_000_000)}M`
  if (d >= 1_000) return `$${trim(d / 1_000)}K`
  return `$${d}`
}

const POLICY_ORDER: InsurancePolicyType[] = ['AUTO_LIABILITY', 'CARGO', 'GENERAL_LIABILITY', 'WORKERS_COMP', 'OTHER']
const SOON_MS = 30 * 24 * 60 * 60 * 1000

export type InsuranceTone = 'ok' | 'soon' | 'bad'
export interface InsuranceChip { type: InsurancePolicyType; text: string; tone: InsuranceTone }

/** "Auto $1M · exp 06/01/27" per policy; Auto and Cargo always show (as "not on file" when missing). */
export function insuranceLines(carrier: Pick<CarrierRecord, 'insurancePolicies'>, now: Date = new Date()): InsuranceChip[] {
  const policies = carrier.insurancePolicies ?? []
  const chips: InsuranceChip[] = []
  for (const type of POLICY_ORDER) {
    const p = policies.find((x) => x.type === type)
    const label = POLICY_LABEL[type]
    if (!p) {
      if (type === 'AUTO_LIABILITY' || type === 'CARGO') chips.push({ type, text: `${label} not on file`, tone: 'bad' })
      continue
    }
    const at = p.expiresAt ? new Date(p.expiresAt).getTime() : null
    const tone: InsuranceTone = at == null ? 'ok' : at < now.getTime() ? 'bad' : at - now.getTime() <= SOON_MS ? 'soon' : 'ok'
    const parts = [label, p.limitCents != null ? shortMoney(p.limitCents) : null, p.expiresAt ? `${tone === 'bad' ? 'expired' : 'exp'} ${policyDate(p.expiresAt)}` : null]
    chips.push({ type, text: parts.filter(Boolean).join(' ').replace(/ (exp|expired) /, ' · $1 '), tone })
  }
  return chips
}
