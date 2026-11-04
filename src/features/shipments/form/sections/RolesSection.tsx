/**
 * Section 6: Roles. Sales / Service representative and Dispatcher Assigned are rep pickers,
 * Dispatcher Actual is derived (who last moved the load), Tariff is free text, Quote links
 * one of the customer's open or won quotes.
 */
import { memo, useMemo } from 'react'
import { RepPicker } from '@/components/RepPicker'
import { TmsInput, TmsSelect } from '@/features/tms/kit'
import { useCustomerQuotes } from '@/hooks/useCustomerQuotes'
import { formatCents } from '@/lib/invoiceBuild'
import { displayName } from '@/lib/roles'
import { MAX } from '../constants'
import { LABEL, labelFor, type LabelDef } from '../labels'
import type { ShipmentFormValues } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { LField } from './formControls'
import { ctl, disabledState, issueFor } from './fieldUtil'

const QUOTABLE = new Set(['QUOTED', 'SENT_COUNTER', 'RECEIVED_REPLY', 'WON'])

type Roles = ShipmentFormValues['roles']

function RolesImpl({ value, onChange, ctx }: SliceSectionProps<'roles'>) {
  const base = disabledState(ctx)
  const quoteLock = disabledState(ctx, 'quote')
  const { quotes } = useCustomerQuotes(ctx.customer?.id ?? null)
  const err = (def: LabelDef) => issueFor(ctx, 'roles', def.testId)

  const actualId = ctx.bundle?.loads[0]?.statusChangedBy ?? ''
  const actual = useMemo(() => {
    if (!actualId) return ''
    const person = ctx.directory.staff.find((p) => p.id === actualId || p.email === actualId)
    return person ? displayName(person) : actualId
  }, [actualId, ctx.directory.staff])

  const quoteOptions = useMemo(
    () => quotes.filter((q) => QUOTABLE.has(q.status) || q.id === value.quoteId).sort((a, b) => b.quoteDate.localeCompare(a.quoteDate)),
    [quotes, value.quoteId],
  )
  const linkedOrder = ctx.bundle?.orders[0]
  const quoteKnown = quoteOptions.some((q) => q.id === value.quoteId)

  const rep = (key: 'salesRepId' | 'serviceRepId' | 'dispatcherAssignedId', def: LabelDef, role?: 'CARRIER_REP') => (
    <LField def={def} error={err(def)}>
      <div role="group" {...ctl(def)}>
        <RepPicker value={value[key]} disabled={base.disabled} role={role} onChange={(id) => onChange({ [key]: id } as Partial<Roles>)} />
      </div>
    </LField>
  )

  return (
    <div className="ship-body" data-testid="section-roles-body">
      {rep('salesRepId', LABEL.roles.salesRepId)}
      {rep('serviceRepId', LABEL.roles.serviceRepId)}
      {rep('dispatcherAssignedId', LABEL.roles.dispatcherAssignedId, 'CARRIER_REP')}
      <LField def={LABEL.roles.dispatcherActual} hint={LABEL.roles.dispatcherActual.help}>
        <TmsInput {...ctl(LABEL.roles.dispatcherActual)} readOnly className="ship-readonly" value={actual} />
      </LField>
      <LField def={LABEL.roles.tariff}>
        <TmsInput {...ctl(LABEL.roles.tariff)} maxLength={MAX.tariff} value={value.tariff} disabled={base.disabled} onChange={(e) => onChange({ tariff: e.target.value })} />
      </LField>
      <LField def={LABEL.roles.quoteId} error={err(LABEL.roles.quoteId)}>
        <TmsSelect
          {...ctl(LABEL.roles.quoteId)} aria-label={labelFor(LABEL.roles.quoteId)} value={value.quoteId}
          disabled={quoteLock.disabled || !ctx.customer} title={quoteLock.title} onChange={(e) => onChange({ quoteId: e.target.value })}
        >
          <option value="" />
          {!quoteKnown && value.quoteId && <option value={value.quoteId}>{linkedOrder?.quoteNumber ?? 'Linked quote'}</option>}
          {quoteOptions.map((q) => (
            <option key={q.id} value={q.id}>{`${q.quoteDate} · ${formatCents(q.amountCents)} · ${q.status}`}</option>
          ))}
        </TmsSelect>
      </LField>
    </div>
  )
}

export const RolesSection = memo(RolesImpl)
