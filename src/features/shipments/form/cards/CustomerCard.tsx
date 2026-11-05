/**
 * Card 1: Customer (Step AR). A type-ahead (five most recently used first), Ref #, then Contact /
 * Phone / Email 1 / Email 2 (the read-only Bill To detail is its own card). Choosing a customer seeds Bill To,
 * contact, the two e-mails, sales rep and division through `applyCustomerDefaults` (never over
 * what a person already typed). Same data and test ids as the AH Customer section.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { effectiveCustomerStatus } from '@/lib/customerCredit'
import { findCustomerMatches } from '@/lib/tmsDirectory'
import { formatPhone } from '@/lib/utils'
import type { CustomerRecord } from '@/types/tms'
import { LABEL, labelFor } from '../labels'
import { applyCustomerDefaults, isLocked, lockReason } from '../model'
import { ctl, disabledState, issueFor } from '../sections/fieldUtil'
import { LField } from '../sections/formControls'
import { type CardProps, sliceOf } from './cardRegistry'
import { pushRecent, readRecents, recentFirst } from './recents'
import { Typeahead, type TypeaheadItem } from './Typeahead'
import './cards.css'

/** Only the first two e-mail slots are on the form; defaults never fill a hidden one. */
const VISIBLE_EMAILS = 2
const OFFERED = 8

export function CustomerCard({ values, update, ctx, form }: CardProps) {
  const value = values.customer
  const onChange = useMemo(() => sliceOf(update, 'customer'), [update])
  const userEmail = useAuthUser()?.email ?? ''
  const [recent, setRecent] = useState(() => readRecents('customer', userEmail))
  const [query, setQuery] = useState<string | null>(null)

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

  const items = useMemo<TypeaheadItem[]>(() => {
    const q = (query ?? '').trim()
    const toItem = (c: CustomerRecord, isRecent: boolean): TypeaheadItem => ({
      id: c.id, label: c.name, sub: isRecent ? 'Recent' : undefined, recent: isRecent,
    })
    if (!q) return recentFirst(shippable, recent).filter((c) => recent.includes(c.id)).map((c) => toItem(c, true))
    const hits = findCustomerMatches(q, shippable).map((m) => m.record)
    return recentFirst(hits, recent).slice(0, OFFERED).map((c) => toItem(c, recent.includes(c.id)))
  }, [query, shippable, recent])

  const pick = (id: string | null) => {
    setQuery(null)
    if (!id) { onChange({ id: '', contactId: '', billToId: '' }); return }
    const picked = ctx.directory.customers.find((c) => c.id === id)
    if (!picked) return
    setRecent(pushRecent('customer', userEmail, id))
    form.update((prev) => {
      const seeded = applyCustomerDefaults({ ...prev, customer: { ...prev.customer, useTyped: false, typedName: '' } }, picked)
      return { ...seeded, customer: { ...seeded.customer, emails: seeded.customer.emails.map((e, i) => (i < VISIBLE_EMAILS ? e : prev.customer.emails[i] ?? '')) } }
    })
  }

  const contacts = (customer?.contacts ?? []).filter((c) => c.active || c.id === value.contactId)
  const selectedContact = contacts.find((c) => c.id === value.contactId)
  const phone = selectedContact?.phone ?? customer?.contactPhone ?? ''
  const billTos = customer?.billToParties ?? []
  const setEmail = (i: number, text: string) =>
    onChange((prev) => ({ ...prev, emails: prev.emails.map((e, n) => (n === i ? text : e)) }))

  return (
    <div className="tms-card-body-stack" data-testid="section-customer-body">
      <div className="tms-card-grid tms-card-grid-name">
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
              <Typeahead
                groupTestId={LABEL.customer.name.testId} inputTestId={`${LABEL.customer.name.testId}-input`}
                ariaLabel={labelFor(LABEL.customer.name)} placeholder="Search customers…"
                value={query ?? customer?.name ?? ''} onValueChange={setQuery} onBlur={() => setQuery(null)}
                items={items} onPick={pick} disabled={base.disabled}
              />
              <TmsIconButton aria-label="Clear customer" data-testid="f-customer-clear" disabled={base.disabled || !value.id} onClick={() => pick(null)}>
                <X size={14} />
              </TmsIconButton>
            </div>
          )}
        </LField>
        <LField def={LABEL.customer.refNo} error={err(LABEL.customer.refNo.testId)} hint={LABEL.customer.refNo.help}>
          <TmsInput {...ctl(LABEL.customer.refNo)} value={value.refNo} disabled={refLocked.disabled} title={refLocked.title} onChange={(e) => onChange({ refNo: e.target.value })} />
        </LField>
      </div>
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
      <div className="tms-card-grid">
        <LField def={LABEL.customer.contact}>
          <TmsSelect {...ctl(LABEL.customer.contact)} value={value.contactId} disabled={contactLocked.disabled} title={contactLocked.title} onChange={(e) => onChange({ contactId: e.target.value })}>
            <option value="" />
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </TmsSelect>
        </LField>
        <LField def={LABEL.customer.phone}>
          <TmsInput {...ctl(LABEL.customer.phone)} readOnly className="ship-readonly" value={phone ? formatPhone(phone) : ''} />
        </LField>
        {value.emails.slice(0, VISIBLE_EMAILS).map((email, i) => {
          const def = LABEL.customer.email(i + 1)
          return (
            <LField key={def.testId} def={def} error={err(def.testId)}>
              <TmsInput {...ctl(def)} type="email" value={email} disabled={base.disabled} onChange={(e) => setEmail(i, e.target.value)} />
            </LField>
          )
        })}
      </div>
      {(billTos.length > 1 || err(LABEL.customer.billTo.testId)) && (
        <div className="tms-card-grid">
          <LField def={LABEL.customer.billTo} error={err(LABEL.customer.billTo.testId)}>
            <TmsSelect {...ctl(LABEL.customer.billTo)} value={value.billToId} disabled={billToLocked.disabled} title={billToLocked.title} onChange={(e) => onChange({ billToId: e.target.value })}>
              <option value="" />
              {billTos.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </TmsSelect>
          </LField>
        </div>
      )}
    </div>
  )
}
