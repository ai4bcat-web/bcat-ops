/**
 * Section 6: Roles. Sales / Service representative and Dispatcher Assigned rep pickers. Tariff,
 * Quote and Dispatcher Actual stay in the model and mapping (values round-trip untouched on save)
 * but are no longer shown on the form (feedback 4).
 */
import { memo } from 'react'
import { RepPicker } from '@/components/RepPicker'
import { LABEL, type LabelDef } from '../labels'
import type { ShipmentFormValues } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { FieldGrid } from '../fieldGrid'
import { LField } from './formControls'
import { ctl, disabledState, issueFor } from './fieldUtil'

type Roles = ShipmentFormValues['roles']

function RolesImpl({ value, onChange, ctx }: SliceSectionProps<'roles'>) {
  const base = disabledState(ctx)
  const err = (def: LabelDef) => issueFor(ctx, 'roles', def.testId)

  const rep = (key: 'salesRepId' | 'serviceRepId' | 'dispatcherAssignedId', def: LabelDef, role?: 'CARRIER_REP') => (
    <LField span={12} def={def} error={err(def)}>
      <div role="group" {...ctl(def)}>
        <RepPicker value={value[key]} disabled={base.disabled} role={role} onChange={(id) => onChange({ [key]: id } as Partial<Roles>)} />
      </div>
    </LField>
  )

  return (
    <FieldGrid testId="section-roles-body">
      {rep('salesRepId', LABEL.roles.salesRepId)}
      {rep('serviceRepId', LABEL.roles.serviceRepId)}
      {rep('dispatcherAssignedId', LABEL.roles.dispatcherAssignedId, 'CARRIER_REP')}
    </FieldGrid>
  )
}

export const RolesSection = memo(RolesImpl)
