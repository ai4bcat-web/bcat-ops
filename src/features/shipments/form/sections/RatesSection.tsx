/**
 * Rates (AH-plan §4.8, Step AR card 4): compact Customer and Carrier rate rows and accessorial
 * lines. Net $ | Profit % live in the summary rail. Every figure comes from `financialPreview`, the function the detail
 * and the server price with; nothing is recomputed here.
 *
 * Carrier money typed before Cover stays in the form (F7); the pipeline never writes a
 * CARRIER charge before the carrier is booked.
 */
import { memo, useMemo, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsIconButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { formatCents } from '@/lib/tmsDirectory'
import { CARRIER_RATE_KIND_OPTIONS, RATE_KIND_OPTIONS } from '../constants'
import { LABEL } from '../labels'
import { financialPreview, paidSlotIndex, paidToOf } from '../mapping'
import { carrierLabel } from '../cards/ratesSummary'
import {
  PAID_TO_NONE, carrierSlotsOf, isLocked, liveCarriers, lockReason,
  type AccessorialLine, type CarrierRate, type CarrierRateKind, type CarrierSlot, type FormRateKind,
} from '../model'
import type { RatesSectionProps as SliceProps } from '../sectionRegistry'
import { Field, FieldGrid, spread } from '../fieldGrid'
import { fieldAttrs } from './fieldAttrs'
import '../cards/moneyCards.css'

/** Rates plus the carrier slots (the Rates card passes every slot so a rate typed on another carrier re-renders the card). */
export type RatesSectionProps = SliceProps & { carriers?: CarrierSlot[] }

const usd = (cents: number) => `$${formatCents(cents)}`

/** What the LH rate box expects for a rate type: the unit goes in the placeholder so the entry box reads as "type here". */
const lhPlaceholder = (kind: string): string =>
  kind === 'PER_MILE' ? '$ per mile' : kind === 'PER_HOUR' ? '$ per hour' : kind === 'PER_CWT' ? '$ per CWT' : '$0.00'

/**
 * A calculated amount: plain text, not an input box, so nobody mistakes it for where the
 * rate goes. Keeps the field's aria-label / test id for screen readers and tests.
 */
function Calculated({ cents, attrs }: { cents: number; attrs: { 'aria-label': string; 'data-testid': string } }) {
  return <output className="tms-rate-calculated" {...attrs}>{cents ? usd(cents) : '—'}</output>
}

function emptyAccessorialLine(): AccessorialLine {
  return { id: '', carrierLineId: '', release: '', paidTo: '', code: '', label: '', carrierAmount: '', customerAmount: '', note: '' }
}

interface RateField { key: string; label: string; info?: string; node: ReactNode }

/** A titled row of rate fields on the shared 12-column grid; the count (hours, pay %) decides the spans so every row stays flush. */
function RateRow({ title, label, fields, testId }: { title: string; label: string; fields: RateField[]; testId?: string }) {
  const { wide, narrow } = spread(fields.length)
  return (
    <div className="tms-card-rate-row" role="group" aria-label={label} data-testid={testId}>
      <span className="tms-card-rate-row-title">{title}</span>
      <FieldGrid>
        {fields.map((f, i) => <Field key={f.key} label={f.label} info={f.info} span={wide[i]!} narrow={narrow[i]}>{f.node}</Field>)}
      </FieldGrid>
    </div>
  )
}

function RatesSectionImpl({ value, onChange, ctx, ship, form, carriers }: RatesSectionProps) {
  const ratesLocked = isLocked(ctx.locked, 'rates')
  const carrierLockedAll = ratesLocked || isLocked(ctx.locked, 'carrierRates')
  const disabled = ctx.busy
  const lockNote = lockReason(ctx.locked, 'rates') ?? lockReason(ctx.locked, 'carrierRates')

  // Slot 0 is the legacy `rates.carrier` / `carrier` pair; the rest come from `carriers` (or the form handle).
  const slots = useMemo<CarrierSlot[]>(() => {
    const all = form.getValues()
    const base = { carrier: all.carrier, carriers: carriers ?? all.carriers, rates: { carrier: value.carrier } }
    return carrierSlotsOf(base)
  }, [form, carriers, value.carrier])
  const multi = slots.length >= 2

  // Rates price off Customer Miles / Weight (`ship`), which arrive with this slice; the rest of
  // the form is not read by pricing. `getValues` is read at render only to complete the object.
  const preview = useMemo(
    () => financialPreview({ ...form.getValues(), rates: value, ship, carriers: slots }, ctx.customer, ctx.settings),
    [form, value, ship, slots, ctx.customer, ctx.settings],
  )

  const cust = value.customer
  const codes = ctx.settings?.chargeCodes ?? []
  const fscBoth = value.fscPercent.trim() !== '' && value.fscPerMile.trim() !== ''
  const carrierName = ctx.directory.carriers.find((c) => c.id === ctx.bundle?.loadCarriers.find((lc) => lc.status === 'ACTIVE')?.carrierId)?.name ?? ''
  const live = liveCarriers(ctx.bundle)

  const setCustomer = (patch: Partial<typeof cust>) => onChange((p) => ({ ...p, customer: { ...p.customer, ...patch } }))
  /** Slot 0 edits the legacy rate row; another slot edits its own `rate` through the whole-values updater. */
  const setRate = (index: number, slot: string, patch: Partial<CarrierRate>) => {
    if (index === 0) onChange((p) => ({ ...p, carrier: { ...p.carrier, ...patch } }))
    else form.update((p) => ({ ...p, carriers: p.carriers.map((s) => (s.slot === slot ? { ...s, rate: { ...s.rate, ...patch } } : s)) }))
  }
  const setLine = (i: number, patch: Partial<AccessorialLine>) =>
    onChange((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }))
  const optionOf = (s: CarrierSlot): string => s.loadCarrierId || s.slot

  const customerFields: RateField[] = [
    { key: 'ct', label: LABEL.rates.customerRateType.text, node: (
      <TmsSelect
        {...fieldAttrs(LABEL.rates.customerRateType)} value={cust.rateType} disabled={disabled || ratesLocked}
        onChange={(e) => setCustomer({ rateType: e.target.value as FormRateKind })}
        options={RATE_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />) },
    ...(cust.rateType === 'PER_HOUR' ? [{ key: 'ch', label: LABEL.rates.customerHours.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.customerHours)} type="number" min={0} step="any" value={cust.hours} disabled={disabled || ratesLocked} onChange={(e) => setCustomer({ hours: e.target.value })} />) }] : []),
    { key: 'lh', label: `${LABEL.rates.customerLhRate.text} — enter here`, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.customerLhRate)} className="tms-rate-entry" inputMode="decimal" placeholder={lhPlaceholder(cust.rateType)} value={cust.lhRate} disabled={disabled || ratesLocked} onChange={(e) => setCustomer({ lhRate: e.target.value })} />) },
    { key: 'tl', label: `${LABEL.rates.customerTotalLh.text} — calculated`, node: <Calculated attrs={fieldAttrs(LABEL.rates.customerTotalLh)} cents={preview.customerTotalLhCents} /> },
    { key: 'fp', label: LABEL.rates.fscPercent.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.fscPercent)} inputMode="decimal" value={value.fscPercent} disabled={disabled || ratesLocked} onChange={(e) => onChange({ fscPercent: e.target.value })} />) },
    { key: 'fm', label: LABEL.rates.fscPerMile.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.fscPerMile)} inputMode="decimal" value={value.fscPerMile} disabled={disabled || ratesLocked} onChange={(e) => onChange({ fscPerMile: e.target.value })} />) },
    { key: 'smr', label: LABEL.rates.smr.text, info: 'Informational, not in Totals', node: (
      <TmsInput {...fieldAttrs(LABEL.rates.smr)} inputMode="decimal" value={value.smr} disabled={disabled || ratesLocked} onChange={(e) => onChange({ smr: e.target.value })} />) },
  ]
  const topSpend = ctx.bundle?.financials[0]?.topSpendCents

  /** One carrier's rate row. Slot 0 keeps the long-standing ids and labels; every other slot's controls are scoped by its key and name. */
  const carrierFieldsOf = (s: CarrierSlot, index: number): RateField[] => {
    const car = s.rate
    const label = carrierLabel(s, index, ctx.directory.carriers, multi)
    const finalized = live.find((lc) => lc.id === s.loadCarrierId)?.chargesFinalizedAt
    const locked = carrierLockedAll || Boolean(finalized)
    const attrs = (def: { testId: string; text: string }, key: string) => (index === 0
      ? fieldAttrs(def as Parameters<typeof fieldAttrs>[0])
      : { 'aria-label': `${label} ${def.text.replace(/^Carrier /, '')}`, 'data-testid': `rates-carrier-${s.slot}-${key}` })
    const set = (patch: Partial<CarrierRate>) => setRate(index, s.slot, patch)
    const linehaulCents = preview.carriers.find((c) => c.slot === s.slot)?.linehaulCents ?? 0
    return [
      { key: 'kt', label: LABEL.rates.carrierRateType.text, node: (
        <TmsSelect
          {...attrs(LABEL.rates.carrierRateType, 'rateType')} value={car.rateType} disabled={disabled || locked}
          onChange={(e) => set({ rateType: e.target.value as CarrierRateKind })}
          options={CARRIER_RATE_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />) },
      ...(car.rateType === 'PER_HOUR' ? [{ key: 'kh', label: LABEL.rates.carrierHours.text, node: (
        <TmsInput {...attrs(LABEL.rates.carrierHours, 'hours')} type="number" min={0} step="any" value={car.hours} disabled={disabled || locked} onChange={(e) => set({ hours: e.target.value })} />) }] : []),
      { key: 'klh', label: car.rateType === 'PCT_OF_CUSTOMER' ? LABEL.rates.carrierLhRate.text : `${LABEL.rates.carrierLhRate.text} — enter here`, node: (
        <TmsInput {...attrs(LABEL.rates.carrierLhRate, 'lhRate')} className="tms-rate-entry" inputMode="decimal" placeholder={lhPlaceholder(car.rateType)} value={car.lhRate} disabled={disabled || locked || car.rateType === 'PCT_OF_CUSTOMER'} onChange={(e) => set({ lhRate: e.target.value })} />) },
      { key: 'ktl', label: `${LABEL.rates.carrierTotalLh.text} — calculated`, node: <Calculated attrs={attrs(LABEL.rates.carrierTotalLh, 'totalLh')} cents={linehaulCents} /> },
      ...(car.rateType === 'PCT_OF_CUSTOMER' ? [{ key: 'kp', label: LABEL.rates.payPct.text, node: (
        <TmsInput {...attrs(LABEL.rates.payPct, 'payPct')} inputMode="decimal" value={car.payPct} disabled={disabled || locked} onChange={(e) => set({ payPct: e.target.value })} />) }] : []),
      { key: 'kmax', label: LABEL.rates.maxRate.text, info: index === 0 && topSpend != null ? `Top spend ${usd(topSpend)}` : undefined, node: (
        <TmsInput {...attrs(LABEL.rates.maxRate, 'maxRate')} inputMode="decimal" value={car.maxRate} disabled={disabled || locked} onChange={(e) => set({ maxRate: e.target.value })} />) },
    ]
  }

  // Column sums come off the priced lines (the same ones the rate con and invoice read): rate lines vs the rest.
  const sumSide = (side: 'CARRIER' | 'CUSTOMER', rate: boolean) =>
    preview.totals.lines.filter((l) => l.side === side && l.isRate === rate).reduce((t, l) => t + l.amountCents, 0)
  const accCarrierCents = sumSide('CARRIER', false)
  const accCustomerCents = sumSide('CUSTOMER', false)
  const fscCents = preview.totals.lines.filter((l) => l.side === 'CUSTOMER' && l.code === 'FSC').reduce((t, l) => t + l.amountCents, 0)

  const pctSum = slots.reduce((sum, s) => sum + (s.rate.rateType === 'PCT_OF_CUSTOMER' && Number(s.rate.payPct) > 0 ? Number(s.rate.payPct) : 0), 0)

  return (
    <div className="tms-card-rates" data-testid="section-rates-body">
      {lockNote && <p className="tms-muted text-xs" data-testid="rates-lock-note">{lockNote}</p>}

      <RateRow title="Customer" label="Customer rate" fields={customerFields} />
      {fscBoth && (
        <p className="tms-card-rate-note" data-testid="rates-fsc-note">
          Use FSC % or FSC/Mile, not both — FSC/Mile wins.
        </p>
      )}
      {slots.map((s, index) => {
        const title = multi ? carrierLabel(s, index, ctx.directory.carriers, true) : 'Carrier'
        return (
          <RateRow
            key={s.slot} testId={`rates-carrier-${s.slot}-rate`} title={title}
            label={multi ? `${title} rate` : 'Carrier rate'} fields={carrierFieldsOf(s, index)}
          />
        )
      })}
      {pctSum > 100 && (
        <p className="tms-card-rate-note" data-testid="rates-pct-note">
          Carrier pay percentages add up to {pctSum}% of the customer linehaul.
        </p>
      )}

      <div className="tms-acc-wrap" data-testid="rates-lines">
        <datalist id="rates-charge-codes">
          {codes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </datalist>
        <table className="tms-acc-table" aria-label="Accessorials: pay carrier and charge customer">
          <thead>
            <tr>
              <th scope="col">{LABEL.rates.release.text}</th>
              <th scope="col">{multi ? 'Paid to' : LABEL.rates.lineCarrier.text}</th>
              <th scope="col">{LABEL.rates.lineAccessorial.text}</th>
              <th scope="col" className="tms-acc-col-carrier" data-testid="rates-head-carrier">Pay carrier</th>
              <th scope="col" className="tms-acc-col-customer" data-testid="rates-head-customer">Charge customer</th>
              <th scope="col"><span className="tms-acc-sr">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="rates-line-linehaul">
              <td data-label={LABEL.rates.release.text} />
              <td data-label="Carrier">{multi ? carrierLabel(slots[0], 0, ctx.directory.carriers, true) : carrierName}</td>
              <td data-label="Accessorial">Line Haul</td>
              <td className="tms-acc-col-carrier tms-acc-amt" data-label="Pay carrier">{usd(preview.carriers[0]?.linehaulCents ?? 0)}</td>
              <td className="tms-acc-col-customer tms-acc-amt" data-label="Charge customer">{usd(preview.customerTotalLhCents)}</td>
              <td />
            </tr>
            {slots.slice(1).map((s, k) => (
              <tr key={s.slot} data-testid={`rates-line-linehaul-${s.slot}`}>
                <td />
                <td data-label="Carrier">{carrierLabel(s, k + 1, ctx.directory.carriers, true)}</td>
                <td data-label="Accessorial">Line Haul</td>
                <td className="tms-acc-col-carrier tms-acc-amt" data-label="Pay carrier">{usd(preview.carriers.find((c) => c.slot === s.slot)?.linehaulCents ?? 0)}</td>
                <td className="tms-acc-col-customer" />
                <td />
              </tr>
            ))}
            {fscCents > 0 && (
              <tr data-testid="rates-line-fsc">
                <td /><td /><td data-label="Accessorial">Fuel surcharge</td>
                <td className="tms-acc-col-carrier" />
                <td className="tms-acc-col-customer tms-acc-amt" data-label="Charge customer">{usd(fscCents)}</td>
                <td />
              </tr>
            )}
            {value.lines.map((line, i) => {
              const target = paidSlotIndex(slots, paidToOf(line, slots))
              const paidTo = target >= 0 ? optionOf(slots[target]) : PAID_TO_NONE
              return (
                <tr key={i} data-testid={`rates-line-${i}`}>
                  <td data-label={LABEL.rates.release.text}>
                    <TmsInput
                      aria-label={`${LABEL.rates.release.text} ${i + 1}`}
                      value={line.release}
                      disabled={disabled || ratesLocked}
                      onChange={(e) => setLine(i, { release: e.target.value })}
                    />
                  </td>
                  <td data-label={multi ? 'Paid to' : 'Carrier'}>
                    {multi ? (
                      <TmsSelect
                        aria-label={`Paid to ${i + 1}`}
                        data-testid={`line-paidTo-${i}`}
                        value={paidTo}
                        disabled={disabled || carrierLockedAll}
                        onChange={(e) => setLine(i, e.target.value === PAID_TO_NONE
                          ? { paidTo: PAID_TO_NONE, carrierAmount: '', carrierLineId: '' }
                          : { paidTo: e.target.value, carrierLineId: e.target.value === paidTo ? line.carrierLineId : '' })}
                        options={[
                          ...slots.map((s, k) => ({ value: optionOf(s), label: carrierLabel(s, k, ctx.directory.carriers, true) })),
                          { value: PAID_TO_NONE, label: 'Not paid to a carrier' },
                        ]}
                      />
                    ) : carrierName}
                  </td>
                  <td data-label="Accessorial">
                    <TmsInput
                      aria-label={`${LABEL.rates.lineAccessorial.text} ${i + 1}`}
                      list="rates-charge-codes"
                      placeholder="Pick or type a code"
                      value={line.code}
                      disabled={disabled || ratesLocked}
                      onChange={(e) => {
                        const code = e.target.value.toUpperCase()
                        const known = codes.find((c) => c.code === code)
                        setLine(i, { code, label: known?.label ?? line.label })
                      }}
                    />
                  </td>
                  <td className="tms-acc-col-carrier" data-label="Pay carrier">
                    <TmsInput
                      aria-label={`${LABEL.rates.lineCarrierAmount.text} ${i + 1}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={line.carrierAmount}
                      disabled={disabled || carrierLockedAll || (multi && paidTo === PAID_TO_NONE)}
                      onChange={(e) => setLine(i, { carrierAmount: e.target.value })}
                    />
                  </td>
                  <td className="tms-acc-col-customer" data-label="Charge customer">
                    <TmsInput
                      aria-label={`${LABEL.rates.lineCustomerAmount.text} ${i + 1}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={line.customerAmount}
                      disabled={disabled || ratesLocked}
                      onChange={(e) => setLine(i, { customerAmount: e.target.value })}
                    />
                  </td>
                  <td>
                    <TmsIconButton
                      shape="plain"
                      aria-label={`Remove accessorial line ${i + 1}`}
                      disabled={disabled || ratesLocked}
                      onClick={() => onChange((p) => ({ ...p, lines: p.lines.filter((_, j) => j !== i) }))}
                    >
                      <Trash2 size={14} />
                    </TmsIconButton>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr data-testid="rates-acc-subtotal">
              <th scope="row" colSpan={3}>Accessorials subtotal</th>
              <td className="tms-acc-col-carrier tms-acc-amt" data-testid="rates-acc-subtotal-carrier">{usd(accCarrierCents)}</td>
              <td className="tms-acc-col-customer tms-acc-amt" data-testid="rates-acc-subtotal-customer">{usd(accCustomerCents)}</td>
              <td />
            </tr>
            <tr className="tms-acc-total" data-testid="rates-acc-total">
              <th scope="row" colSpan={3}>Totals</th>
              <td className="tms-acc-col-carrier tms-acc-amt" data-testid="rates-total-carrier">
                <span className="tms-acc-total-label">Pay carrier total</span> {usd(preview.carrierTotalCents)}
              </td>
              <td className="tms-acc-col-customer tms-acc-amt" data-testid="rates-total-customer">
                <span className="tms-acc-total-label">Charge customer total</span> {usd(preview.customerTotalCents)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
        <div>
          <TmsButton
            size="sm"
            data-testid={LABEL.rates.addLine.testId}
            aria-label="Add accessorial line"
            disabled={disabled || ratesLocked}
            onClick={() => onChange((p) => ({ ...p, lines: [...p.lines, emptyAccessorialLine()] }))}
          >
            <Plus size={14} className="mr-1" /> Add accessorial
          </TmsButton>
        </div>
      </div>
    </div>
  )
}

export const RatesSection = memo(RatesSectionImpl)
