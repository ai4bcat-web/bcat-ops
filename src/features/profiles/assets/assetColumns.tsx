import { TmsBadge } from '@/features/tms/kit'
import type { ApColumn } from '@/features/ap/ApDenseList'
import type { Driver } from '@/types'
import type { Equipment } from '@/types/equipment'
import { formatVin } from '@/lib/utils'
import type { DocsSummary } from '../driverProfileModel'
import { assetFleetLabel, ASSET_FLEET_OPTIONS, makeModel, OWNERSHIP_LABEL, type AssetDates } from '../assetProfileModel'

export interface AssetRow {
  equip: Equipment
  drivers: Driver[]
  docs: DocsSummary
  dates: AssetDates
}

const TONE = { green: 'green', orange: 'orange', red: 'red', gray: 'gray' } as const
const blank = <span className="tms-muted">—</span>
const driverText = (r: AssetRow) => r.drivers.map((d) => d.name).join(', ')

function dateColumn(key: string, header: string, pick: (r: AssetRow) => string | undefined): ApColumn<AssetRow> {
  return { key, header, group: 'Compliance', filter: 'date', text: (r) => pick(r) ?? '', dateOf: (r) => pick(r) ?? null, render: (r) => pick(r) ?? blank }
}

/** Columns of the asset lists (the same set for trucks and trailers; IFTA/IRP are empty for trailers). */
export function assetColumns(): ApColumn<AssetRow>[] {
  return [
    { key: 'unit', header: 'Unit', group: 'Asset', text: (r) => r.equip.unitNumber, render: (r) => <strong>{r.equip.unitNumber}</strong> },
    { key: 'nickname', header: 'Nickname', group: 'Asset', text: (r) => r.equip.nickname ?? '', render: (r) => r.equip.nickname || blank },
    { key: 'make', header: 'Make / model', group: 'Asset', filter: 'multi', text: (r) => makeModel(r.equip), render: (r) => makeModel(r.equip) || blank },
    { key: 'vin', header: 'VIN', group: 'Asset', text: (r) => formatVin(r.equip.vin) || '', render: (r) => formatVin(r.equip.vin) || blank },
    { key: 'plate', header: 'Plate', group: 'Asset', text: (r) => r.equip.plate ?? '', render: (r) => r.equip.plate || blank },
    {
      key: 'status', header: 'Status', group: 'Asset', filter: 'multi',
      text: (r) => (r.equip.active ? 'Active' : 'Inactive'),
      render: (r) => <TmsBadge tone={r.equip.active ? 'green' : 'gray'}>{r.equip.active ? 'Active' : 'Inactive'}</TmsBadge>,
    },
    {
      key: 'fleet', header: 'Fleet', group: 'Asset', filter: 'multi',
      text: (r) => assetFleetLabel(r.equip.fleetGroup), render: (r) => assetFleetLabel(r.equip.fleetGroup),
      fixedOptions: [...ASSET_FLEET_OPTIONS.map((o) => ({ value: o.label, label: o.label })), { value: 'Unassigned', label: 'Unassigned' }],
    },
    {
      key: 'ownership', header: 'Ownership', group: 'Asset', filter: 'multi',
      text: (r) => OWNERSHIP_LABEL[r.equip.ownership] ?? r.equip.ownership, render: (r) => OWNERSHIP_LABEL[r.equip.ownership] ?? r.equip.ownership,
    },
    { key: 'driver', header: 'Driver', group: 'Assignment', filter: 'multi', text: driverText, render: (r) => driverText(r) || blank },
    {
      key: 'docs', header: 'Documents', group: 'Compliance', filter: 'multi', text: (r) => r.docs.label,
      sortValue: (r) => r.docs.missing * 100 + r.docs.attention, render: (r) => <TmsBadge tone={TONE[r.docs.tone]}>{r.docs.label}</TmsBadge>,
    },
    dateColumn('dot', 'DOT inspection', (r) => r.dates.dot),
    dateColumn('ins', 'Insurance expires', (r) => r.dates.ins),
    dateColumn('ifta', 'IFTA expires', (r) => r.dates.ifta),
    dateColumn('irp', 'IRP expires', (r) => r.dates.irp),
    {
      key: 'mileage', header: 'Mileage', group: 'Asset', filter: 'number', align: 'right',
      text: (r) => (r.equip.mileage != null ? r.equip.mileage.toLocaleString() : ''), numberOf: (r) => r.equip.mileage ?? null,
      render: (r) => (r.equip.mileage != null ? r.equip.mileage.toLocaleString() : blank),
    },
  ]
}
