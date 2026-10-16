import { useState } from 'react'
import { Truck } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'

/**
 * Staff control for which truck a driver is in. One driver per truck: picking a truck that
 * another driver holds moves it to this driver and clears it from the other, the same way
 * the driver's own picker does. Writes both sides of the assignment (store).
 */
export function TruckAssignSelect({ driverId, label = 'Truck', compact = false }: { driverId: string; label?: string; compact?: boolean }) {
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)
  const assignTruckToDriver = useAppStore((s) => s.assignTruckToDriver)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const driver = drivers.find((d) => d.id === driverId)
  if (!driver) return null
  const trucks = equipment
    .filter((e) => e.type === 'truck' && e.active !== false)
    .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
  const holderOf = (truckId: string) => drivers.find((d) => d.assignedTruckId === truckId && d.id !== driverId)?.name

  const onChange = async (truckId: string) => {
    setBusy(true); setNote(null)
    try {
      if (!truckId) {
        if (driver.assignedTruckId) await assignTruckToDriver(driver.assignedTruckId, null)
      } else {
        const taken = holderOf(truckId)
        await assignTruckToDriver(truckId, driverId)
        const unit = trucks.find((t) => t.id === truckId)?.unitNumber ?? ''
        setNote(taken ? `#${unit} moved from ${taken} to ${driver.name}` : `${driver.name} is now in #${unit}`)
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not change the truck')
    } finally {
      setBusy(false)
    }
  }

  const id = `truck-assign-${driverId}`
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: compact ? 12 : 13 }}>
      <label htmlFor={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--ds-t3)', fontWeight: 600 }}>
        <Truck size={compact ? 12 : 14} aria-hidden="true" /> {label}
      </label>
      <select
        id={id}
        value={driver.assignedTruckId ?? ''}
        disabled={busy}
        onChange={(e) => { void onChange(e.target.value) }}
        title="Which truck this driver is in. Picking a truck another driver holds moves it to this driver."
        style={{ fontSize: compact ? 12 : 13, fontWeight: 600, padding: compact ? '2px 6px' : '4px 8px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontVariantNumeric: 'tabular-nums', cursor: busy ? 'wait' : 'pointer' }}
      >
        <option value="">No truck</option>
        {trucks.map((t) => {
          const holder = holderOf(t.id)
          return <option key={t.id} value={t.id}>#{t.unitNumber}{holder ? ` · ${holder}` : ''}</option>
        })}
      </select>
      {note && <span style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{note}</span>}
    </span>
  )
}
