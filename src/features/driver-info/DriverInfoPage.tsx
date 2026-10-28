import { TruckMapWidget } from '@/features/dashboard/TruckMapWidget'
import { useIsMobile } from '@/hooks/useIsMobile'
import { IvanPhones } from './IvanPhones'

/**
 * Driver info — where every truck is right now, who is in it, the load under way, the
 * tracking link and the one-click copy block for brokers. The fleet table that used to
 * sit on the dashboard, on its own page beside Dispatch.
 */
export function DriverInfoPage() {
  const isMobile = useIsMobile()
  return (
    <div className="h-full overflow-y-auto">
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: isMobile ? '16px 12px' : '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--ds-t1)', margin: 0 }}>Driver info</h1>
          <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 3 }}>Where each truck is, who is driving it, the load under way, and the tracking link and info block to hand a broker</p>
        </div>
        <TruckMapWidget />
        <IvanPhones />
      </div>
    </div>
  )
}
