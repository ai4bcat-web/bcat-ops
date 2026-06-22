import { FleetPLTrendChart } from '@/features/fleet-profitability/FleetPLTrendChart'
import { FleetProfitabilitySection } from '@/features/fleet-profitability/FleetProfitabilitySection'
import { MonthlyFleetPL } from '@/features/fleet-profitability/MonthlyFleetPL'
import { CombinedMonthlyProfit } from './CombinedMonthlyProfit'
import { FleetExpensesCard } from './FleetExpensesCard'
import { useIsMobile } from '@/hooks/useIsMobile'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
      <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ds-t3)', margin: 0, whiteSpace: 'nowrap' }}>
        {children}
      </h2>
      <div style={{ flex: 1, height: 1, background: 'var(--ds-border)' }} />
    </div>
  )
}

/**
 * Finances — grouped into two sections: Profitability (combined + fleet/Amazon
 * dashboards) and Expenses (editable monthly fixed costs).
 */
export function FinancesPage() {
  const isMobile = useIsMobile()
  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Page header */}
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>
            Finances
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>
            Profitability dashboards and monthly fixed costs
          </p>
        </div>

        <SectionHeading>Profitability</SectionHeading>
        <CombinedMonthlyProfit />
        <FleetPLTrendChart />
        <FleetProfitabilitySection />
        <MonthlyFleetPL />

        <SectionHeading>Expenses</SectionHeading>
        <FleetExpensesCard />
      </div>
    </div>
  )
}
