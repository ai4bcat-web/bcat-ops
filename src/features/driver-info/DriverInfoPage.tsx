import { TruckMapWidget } from '@/features/dashboard/TruckMapWidget'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { IvanPhones } from './IvanPhones'

/**
 * Driver info — where every truck is right now, who is in it, the load under way, the
 * tracking link and the one-click copy block for brokers. The fleet table that used to
 * sit on the dashboard, on its own page beside Dispatch.
 */
export function DriverInfoPage() {
  return (
    <TmsScrollPage
      title="Driver info"
      subtitle="Where each truck is, who is driving it, the load under way, and the tracking link and info block to hand a broker"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <TruckMapWidget />
        <IvanPhones />
      </div>
    </TmsScrollPage>
  )
}
