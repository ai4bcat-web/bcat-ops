import { FleetProfitabilitySection } from '@/features/fleet-profitability/FleetProfitabilitySection'
import { MonthlyFleetPL } from '@/features/fleet-profitability/MonthlyFleetPL'
import { useIsMobile } from '@/hooks/useIsMobile'

/**
 * Finances — home for the fleet profitability dashboards (Weekly Profitability and
 * Monthly Profit & Loss), moved off the operations Dashboard so the financial views
 * live in one place.
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
            Fleet profitability — weekly P&amp;L by truck and monthly profit &amp; loss
          </p>
        </div>

        <FleetProfitabilitySection />
        <MonthlyFleetPL />
      </div>
    </div>
  )
}
