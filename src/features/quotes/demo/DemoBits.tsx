import { TmsBadge } from '@/features/tms/kit'
import type { DemoOutcome } from '../demoQuotes'
import { DEMO_OUTCOME_LABEL, DEMO_OUTCOME_TONE } from './demoFormat'
import '../quotesDemo.css'
export function DemoBadge() {
  return <span className="tms-qd-demo-badge" data-testid="demo-badge">DEMO DATA</span>
}

export function DemoOutcomeChip({ outcome }: { outcome: DemoOutcome }) {
  return <TmsBadge tone={DEMO_OUTCOME_TONE[outcome]} data-testid="demo-outcome">{DEMO_OUTCOME_LABEL[outcome]}</TmsBadge>
}

export function WinBar({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100)
  const tone = pct >= 60 ? '' : pct >= 35 ? ' tms-qd-bar-mid' : ' tms-qd-bar-low'
  return (
    <div className="tms-qd-rate-cell">
      <div className={`tms-qd-bar${tone}`} role="presentation"><span style={{ width: `${pct}%` }} /></div>
      <span className="tms-qd-pct">{pct}%</span>
    </div>
  )
}
