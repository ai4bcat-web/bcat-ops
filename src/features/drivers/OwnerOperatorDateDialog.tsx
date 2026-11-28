import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthUser } from '@/hooks/useAuth'
import type { OwnerOperatorChange } from '@/lib/ownerOperatorChange'

const today = () => new Date().toLocaleDateString('en-CA')

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
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{start ? 'Owner operator effective from' : 'Owner operator until'}</DialogTitle>
          <DialogDescription>
            {start
              ? `${driverName} is being switched to owner operator. Settlements on the Owner Operator Settlements page start from this date. Loads delivered earlier stay with how they were paid before, and settlements already paid are not changed.`
              : `${driverName} is being switched away from owner operator. This is their last day on the Owner Operator Settlements page. Loads delivered after it are not on their statements, and settlements already paid are not changed.`}
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="oo-effective-date" style={{ fontSize: 13, fontWeight: 600 }}>{start ? 'Owner operator effective from' : 'Last day as an owner operator'}</label>
        <Input id="oo-effective-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={!valid} />
        {!valid && <span role="alert" style={{ fontSize: 12, color: 'var(--tms-badge-red)' }}>Pick a date.</span>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" disabled={!valid} onClick={() => onConfirm(day, user?.email ?? 'unknown')}>Save driver</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
