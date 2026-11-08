import { useMemo } from 'react'
import { payCadence } from '@/lib/payrollCadence'

/** One muted line stating the Wednesday pay rhythm. A label only: no controls, no pay math. */
export function PayrollCadenceBanner() {
  const { label } = useMemo(() => payCadence(new Date()), [])
  return (
    <p data-testid="payroll-cadence" style={{ margin: 0, fontSize: 12.5, color: 'var(--tms-muted)' }}>
      {label}
    </p>
  )
}
