import { useState } from 'react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthUser } from '@/hooks/useAuth'
import type { OwnerOperatorChange } from '@/lib/ownerOperatorChange'

const today = () => new Date().toLocaleDateString('en-CA')

/** Above the driver drawer's overlay and panel (60/61), which this dialog opens over. Left lower it is dimmed by them and cannot be clicked. */
const OVER_DRAWER = 80

/**
 * Asked whenever an existing driver is switched to or from owner operator: the date decides which settlement weeks are theirs. Required, and
 * a past date is fine (the switch is often noticed late). Nothing already settled changes.
 */
export function OwnerOperatorDateDialog({ change, driverName, onConfirm, onCancel }: {
  change: OwnerOperatorChange
  driverName: string
  onConfirm: (day: string, who: string) => void
  onCancel: () => void
}) {
  const user = useAuthUser()
  const [day, setDay] = useState(today())
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(new Date(`${day}T12:00:00Z`).getTime())
  const start = change === 'START'
  const description = start
    ? `${driverName} is being switched to owner operator. Settlements on the Owner Operator Settlements page start from this date. Loads delivered earlier stay with how they were paid before, and settlements already paid are not changed.`
    : `${driverName} is being switched away from owner operator. This is their last day on the Owner Operator Settlements page. Loads delivered after it are not on their statements, and settlements already paid are not changed.`
  const confirm = () => { if (valid) onConfirm(day, user?.email ?? 'unknown') }
  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onCancel() }}
      zIndex={OVER_DRAWER}
      title={start ? 'Owner operator effective from' : 'Owner operator until'}
      description={description}
    >
      <form onSubmit={(e) => { e.preventDefault(); confirm() }} style={{ display: 'grid', gap: 12 }}>
        <label htmlFor="oo-effective-date" style={{ fontSize: 13, fontWeight: 600 }}>{start ? 'Owner operator effective from' : 'Last day as an owner operator'}</label>
        <Input id="oo-effective-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={!valid} autoFocus />
        {!valid && <span role="alert" style={{ fontSize: 12, color: 'var(--tms-badge-red)' }}>Pick a date to save.</span>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={!valid}>Save driver</Button>
        </div>
      </form>
    </TmsDialog>
  )
}
