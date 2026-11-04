import { useState } from 'react'
import { Phone } from 'lucide-react'
import { TruckPhoneEditor } from '@/features/trucks/TruckPhoneEditor'
import { TmsButton } from '@/features/tms/kit'
import { useTruckConfigs } from '@/hooks/useTruckConfigs'
import { useAppStore } from '@/store/useAppStore'
import { trucksWithoutPhone } from '@/lib/workPhone'
import { Hint, Loading, SettingsCard } from './settingsKit'

/**
 * Step AK — the trucks that cannot be texted on a work phone yet: active trucks with no valid
 * `TruckConfig.phone`. Each row can take the number right here (same editor as Fleet).
 */
export function TruckPhonesCard() {
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const { byId, loading } = useTruckConfigs()
  const [editing, setEditing] = useState<string | null>(null)

  const missing = trucksWithoutPhone({ equipment, configs: byId })
  const driverName = (truckId: string, assignedDriverId: string | null) =>
    drivers.find((d) => d.id === assignedDriverId || d.assignedTruckId === truckId)?.name ?? null

  return (
    <SettingsCard
      icon={Phone}
      title="Truck work phones"
      description="Drivers are texted on the phone that rides in their truck. Trucks without one fall back to the driver's personal number."
    >
      {loading ? <Loading /> : missing.length === 0 ? (
        <Hint>All trucks have a work phone.</Hint>
      ) : (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>
            Trucks without a phone ({missing.length})
          </p>
          <table className="tms-table" style={{ width: '100%' }}>
            <thead>
              <tr><th style={{ textAlign: 'left' }}>Truck</th><th style={{ textAlign: 'left' }}>Driver</th><th style={{ textAlign: 'left' }}>Phone</th></tr>
            </thead>
            <tbody>
              {missing.map((t) => (
                <tr key={t.truckId}>
                  <td>#{t.unitNumber}</td>
                  <td>{driverName(t.truckId, t.assignedDriverId) ?? '—'}</td>
                  <td>
                    {editing === t.truckId ? (
                      <TruckPhoneEditor
                        truckId={t.truckId}
                        unitNumber={t.unitNumber}
                        phone={byId.get(t.truckId)?.phone}
                        phoneLabel={byId.get(t.truckId)?.phoneLabel}
                        onDone={() => setEditing(null)}
                      />
                    ) : (
                      <TmsButton size="sm" onClick={() => setEditing(t.truckId)} aria-label={`Add phone, truck ${t.unitNumber}`}>Add phone</TmsButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SettingsCard>
  )
}
