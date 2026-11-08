import { Link } from 'react-router-dom'
import { ClipboardList } from 'lucide-react'
import { FleetPLTrendChart } from '@/features/fleet-profitability/FleetPLTrendChart'
import { FleetProfitabilitySection } from '@/features/fleet-profitability/FleetProfitabilitySection'
import { MonthlyFleetPL } from '@/features/fleet-profitability/MonthlyFleetPL'
import { CombinedMonthlyProfit } from './CombinedMonthlyProfit'
import { FleetExpensesCard } from './FleetExpensesCard'
import { DispatchCostsCard } from './DispatchCostsCard'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--tms-muted)', margin: 0, whiteSpace: 'nowrap' }}>
        {children}
      </h2>
      <div style={{ flex: 1, height: 1, background: 'var(--tms-border)' }} />
    </div>
  )
}

/**
 * Finances — grouped into two sections: Profitability (combined + fleet/Amazon
 * dashboards) and Expenses (editable monthly fixed costs).
 */
export function FinancesPage() {
  return (
    <TmsScrollPage title="Finances" subtitle="Profitability dashboards and monthly fixed costs">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        <SectionHeading>Profitability</SectionHeading>
        <Link to="/finances/review" style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--tms-text)', textDecoration: 'none', border: '1px solid var(--tms-border)', borderRadius: 8, padding: '6px 10px', background: 'var(--tms-card)' }}>
          <ClipboardList size={14} /> Profit Review — month over month, what to change, rate-per-mile projections
        </Link>
        <CombinedMonthlyProfit />
        <FleetPLTrendChart />
        <FleetProfitabilitySection />
        <MonthlyFleetPL />

        <SectionHeading>Expenses</SectionHeading>
        <FleetExpensesCard />
        <DispatchCostsCard />
      </div>
    </TmsScrollPage>
  )
}
