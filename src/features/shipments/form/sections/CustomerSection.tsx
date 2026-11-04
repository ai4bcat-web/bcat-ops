/**
 * Section 2: Customer. Name (directory picker, ACTIVE/DORMANT only, ✕ clear), the customer's
 * address read from the record, Contact / Phone / Hours / six Email slots / Ref # / Bill to.
 * Picking a customer seeds the defaults through `applyCustomerDefaults` (never overwriting
 * what a person already typed).
 */
import { memo, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { DirectoryPicker } from '@/components/directory-picker/DirectoryPicker'
import { TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import { formatPhone } from '@/lib/utils'
import type { CustomerRecord, LocationRecord } from '@/types/tms'
import { applyCustomerDefaults, isLocked, lockReason } from '../model'
import { LABEL, labelFor } from '../labels'
import type { SliceSectionProps } from '../sectionRegistry'
import { LField } from './formControls'
import { ctl, disabledState, issueFor } from './fieldUtil'

function CustomerImpl({ value, onChange, ctx, form }: SliceSectionProps<'customer'>) {
  const base = disabledState(ctx)
  const customer = ctx.customer
  const nameLocked = isLocked(ctx.locked, 'customer')
  const billToLocked = disabledState(ctx, 'billTo')
  const contactLocked = disabledState(ctx, 'contact')
  const refLocked = disabledState(ctx, 'references')
  const err = (testId: string) => issueFor(ctx, 'customer', testId)

  const shippable = useMemo(() => {
    const now = new Date().toISOString()
    return ctx.directory.customers.filter((c) => {
      const status = effectiveCustomerStatus(c, null, now)
      return status === 'ACTIVE' || status === 'DORMANT'
    })
  }, [ctx.directory.customers])

  const pick = (id: string | null, record?: CustomerRecord | LocationRecord | null) => {
    if (!id) { onChange({ id: '', contactId: '', billToId: '' }); return }
    const picked = (record as CustomerRecord | null | undefined) ?? ctx.directory.customers.find((c) => c.id === id) ?? null
    if (!picked) return
    form.update((prev) => applyCustomerDefaults({ ...prev, customer: { ...prev.customer, useTyped: false, typedName: '' } }, picked))
  }

  const contacts = (customer?.contacts ?? []).filter((c) => c.active || c.id === value.contactId)
  const selectedContact = contacts.find((c) => c.id === value.contactId)
  const phone = selectedContact?.phone ?? customer?.contactPhone ?? ''
  const addr = customer?.billingAddress
  const billTos = customer?.billToParties ?? []
  const setEmail = (i: number, text: string) =>
    onChange((prev) => ({ ...prev, emails: prev.emails.map((e, n) => (n === i ? text : e)) }))

  const ro = (def: { text: string; testId: string }, text: string | null | undefined) => (
    <LField def={def as typeof LABEL.customer.address}>
      <TmsInput {...ctl(def as typeof LABEL.customer.address)} readOnly className="ship-readonly" value={text ?? ''} />
    </LField>
  )

  return (
    <div className="ship-body" data-testid="section-customer-body">
      <LField def={LABEL.customer.name} error={err(LABEL.customer.name.testId)}>
        {nameLocked ? (
          <div className="ship-inline">
            <TmsInput {...ctl(LABEL.customer.name)} readOnly value={customer?.name ?? value.typedName} title={lockReason(ctx.locked, 'customer')} />
            {ctx.bundle && <Link className="ship-link" to={`/tms/shipments/${ctx.bundle.shipment.id}`}>Change customer…</Link>}
          </div>
        ) : value.useTyped ? (
          <TmsInput
            {...ctl(LABEL.customer.name)} value={value.typedName} disabled={base.disabled}
            onChange={(e) => onChange({ typedName: e.target.value, id: '' })}
          />
        ) : (
          <div className="ship-inline">
            <div role="group" {...ctl(LABEL.customer.name)} style={{ flex: '1 1 auto', minWidth: 0 }}>
              <DirectoryPicker
                type="customer" value={value.id || null} customers={shippable} locations={ctx.directory.locations}
                placeholder="Select customer…" onChange={pick}
              />
            </div>
            <TmsIconButton aria-label="Clear customer" data-testid="f-customer-clear" disabled={base.disabled || !value.id} onClick={() => pick(null)}>
              <X size={14} />
            </TmsIconButton>
          </div>
        )}
      </LField>
      {!nameLocked && !value.id && (
        <label className="ship-check">
          <input
            type="checkbox" data-testid="f-customer-useTyped" aria-label="No matching customer — record the name for now"
            checked={value.useTyped} disabled={base.disabled} onChange={(e) => onChange({ useTyped: e.target.checked, typedName: e.target.checked ? value.typedName : '' })}
          />
          No matching customer — record the name for now
        </label>
      )}
      {customer && (
        <span className="ship-hint">
          From the customer record · <Link className="ship-link" to={`/tms/customers/${customer.id}`}>Edit customer</Link>
        </span>
      )}
      {ro(LABEL.customer.address, addr?.street)}
      {ro(LABEL.customer.city, addr?.city)}
      <div className="ship-inline">
        {ro(LABEL.customer.state, addr?.state)}
        {ro(LABEL.customer.zip, addr?.zip)}
      </div>
      {ro(LABEL.customer.country, addr?.country)}
      <LField def={LABEL.customer.contact}>
        <TmsSelect {...ctl(LABEL.customer.contact)} value={value.contactId} disabled={contactLocked.disabled} title={contactLocked.title} onChange={(e) => onChange({ contactId: e.target.value })}>
          <option value="" />
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </TmsSelect>
      </LField>
      {ro(LABEL.customer.phone, phone ? formatPhone(phone) : '')}
      <LField def={LABEL.customer.hours}>
        <TmsInput {...ctl(LABEL.customer.hours)} value={value.hours} disabled={base.disabled} onChange={(e) => onChange({ hours: e.target.value })} />
      </LField>
      {value.emails.map((email, i) => {
        const def = LABEL.customer.email(i + 1)
        return (
          <LField key={def.testId} def={def} error={err(def.testId)}>
            <TmsInput {...ctl(def)} type="email" aria-label={labelFor(def)} value={email} disabled={base.disabled} onChange={(e) => setEmail(i, e.target.value)} />
          </LField>
        )
      })}
      <LField def={LABEL.customer.refNo} error={err(LABEL.customer.refNo.testId)}>
        <TmsInput {...ctl(LABEL.customer.refNo)} value={value.refNo} disabled={refLocked.disabled} title={refLocked.title} onChange={(e) => onChange({ refNo: e.target.value })} />
      </LField>
      <LField def={LABEL.customer.billTo} error={err(LABEL.customer.billTo.testId)}>
        <TmsSelect {...ctl(LABEL.customer.billTo)} value={value.billToId} disabled={billToLocked.disabled} title={billToLocked.title} onChange={(e) => onChange({ billToId: e.target.value })}>
          <option value="" />
          {billTos.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </TmsSelect>
      </LField>
    </div>
  )
}

export const CustomerSection = memo(CustomerImpl)
