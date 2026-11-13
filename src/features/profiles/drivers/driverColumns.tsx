import { TmsBadge } from '@/features/tms/kit'
import { needsHireDate } from '@/lib/ptoAllowance'
import type { ApColumn } from '@/features/ap/ApDenseList'
import { fleetLabel, FLEET_OPTIONS, missingDriverFields, type DocsSummary } from '../driverProfileModel'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import type { DriverPaySetting } from '@/lib/apiClient'

export interface DriverRow {
  driver: Driver
  truck: Equipment | undefined
  trailer: Equipment | undefined
  docs: DocsSummary
  pay: DriverPaySetting | undefined
}

const TONE = { green: 'green', orange: 'orange', red: 'red', gray: 'gray' } as const
const dash = (s: string | null | undefined) => (s && s.trim() ? s : '')

/** Columns of the driver list. The grid's own filters, sort, widths and saved layout come with it. */
export function driverColumns(): ApColumn<DriverRow>[] {
  return [
    {
      key: 'name', header: 'Driver', group: 'Driver', text: (r) => r.driver.name,
      render: (r) => {
        const missing = missingDriverFields(r.driver)
        return (
          <span className="inline-flex items-center gap-2">
            <strong>{r.driver.name}</strong>
            {missing.length > 0 ? (
              <span title={`Missing: ${missing.join(', ')}`} data-testid={`driver-missing-${r.driver.id}`}>
                <TmsBadge tone="orange">Missing info</TmsBadge>
              </span>
            ) : null}
          </span>
        )
      },
    },
    {
      key: 'type', header: 'Type', group: 'Driver', filter: 'multi',
      text: (r) => fleetLabel(r.driver.fleetGroup), render: (r) => fleetLabel(r.driver.fleetGroup),
      fixedOptions: [...FLEET_OPTIONS.map((o) => ({ value: o.label, label: o.label })), { value: 'Unassigned', label: 'Unassigned' }],
    },
    {
      key: 'status', header: 'Status', group: 'Driver', filter: 'multi',
      text: (r) => (r.driver.active ? 'Active' : 'Inactive'),
      render: (r) => <TmsBadge tone={r.driver.active ? 'green' : 'gray'}>{r.driver.active ? 'Active' : 'Inactive'}</TmsBadge>,
    },
    {
      key: 'truck', header: 'Truck', group: 'Equipment',
      text: (r) => (r.truck ? `Truck ${r.truck.unitNumber}` : ''), render: (r) => (r.truck ? `Truck ${r.truck.unitNumber}` : <span className="tms-muted">—</span>),
    },
    {
      key: 'trailer', header: 'Trailer', group: 'Equipment',
      text: (r) => (r.trailer ? `Trailer ${r.trailer.unitNumber}` : r.driver.bobtail ? 'Bobtail' : ''),
      render: (r) => (r.trailer ? `Trailer ${r.trailer.unitNumber}` : r.driver.bobtail ? 'Bobtail' : <span className="tms-muted">—</span>),
    },
    { key: 'phone', header: 'Phone', group: 'Contact', text: (r) => r.driver.phone ?? '', render: (r) => r.driver.phone },
    { key: 'email', header: 'E-mail', group: 'Contact', text: (r) => dash(r.driver.email), render: (r) => dash(r.driver.email) || <span className="tms-muted">—</span> },
    {
      key: 'dispatcher', header: 'Dispatcher', group: 'Driver', filter: 'multi',
      text: (r) => dash(r.driver.dispatcherPrimary), render: (r) => dash(r.driver.dispatcherPrimary) || <span className="tms-muted">—</span>,
    },
    {
      key: 'docs', header: 'Documents', group: 'Compliance', filter: 'multi',
      text: (r) => r.docs.label,
      sortValue: (r) => r.docs.missing * 100 + r.docs.attention,
      render: (r) => <TmsBadge tone={TONE[r.docs.tone]}>{r.docs.label}</TmsBadge>,
    },
    {
      key: 'pay', header: 'Pay %', group: 'Pay', filter: 'number', align: 'right',
      text: (r) => (r.pay ? `${Math.round(r.pay.payPercent * 1000) / 10}%` : ''),
      numberOf: (r) => (r.pay ? Math.round(r.pay.payPercent * 1000) / 10 : null), numberUnit: '%',
      render: (r) => (r.pay ? `${Math.round(r.pay.payPercent * 1000) / 10}%` : <span className="tms-muted">—</span>),
    },
    {
      key: 'cdl', header: 'CDL expires', group: 'Compliance', filter: 'date',
      text: (r) => r.driver.cdlExpiration ?? '', dateOf: (r) => r.driver.cdlExpiration ?? null,
      render: (r) => r.driver.cdlExpiration ?? <span className="tms-muted">—</span>,
    },
    {
      key: 'medcard', header: 'Med card expires', group: 'Compliance', filter: 'date',
      text: (r) => r.driver.medCardExpiration ?? '', dateOf: (r) => r.driver.medCardExpiration ?? null,
      render: (r) => r.driver.medCardExpiration ?? <span className="tms-muted">—</span>,
    },
    {
      key: 'hired', header: 'Hired', group: 'Driver', filter: 'date',
      text: (r) => r.driver.hireDate ?? '', dateOf: (r) => r.driver.hireDate ?? null,
      render: (r) => r.driver.hireDate ?? (needsHireDate(r.driver) ? <TmsBadge tone="orange">Needs hire date</TmsBadge> : <span className="tms-muted">—</span>),
    },
  ]
}

