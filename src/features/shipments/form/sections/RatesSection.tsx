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
    { key: 'lh', label: LABEL.rates.customerLhRate.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.customerLhRate)} inputMode="decimal" value={cust.lhRate} disabled={disabled || ratesLocked} onChange={(e) => setCustomer({ lhRate: e.target.value })} />) },
    { key: 'tl', label: LABEL.rates.customerTotalLh.text, node: <TmsInput {...fieldAttrs(LABEL.rates.customerTotalLh)} readOnly value={usd(preview.customerTotalLhCents)} /> },
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
      { key: 'klh', label: LABEL.rates.carrierLhRate.text, node: (
        <TmsInput {...attrs(LABEL.rates.carrierLhRate, 'lhRate')} inputMode="decimal" value={car.lhRate} disabled={disabled || locked || car.rateType === 'PCT_OF_CUSTOMER'} onChange={(e) => set({ lhRate: e.target.value })} />) },
      { key: 'ktl', label: LABEL.rates.carrierTotalLh.text, node: <TmsInput {...attrs(LABEL.rates.carrierTotalLh, 'totalLh')} readOnly value={usd(linehaulCents)} /> },
      ...(car.rateType === 'PCT_OF_CUSTOMER' ? [{ key: 'kp', label: LABEL.rates.payPct.text, node: (
        <TmsInput {...attrs(LABEL.rates.payPct, 'payPct')} inputMode="decimal" value={car.payPct} disabled={disabled || locked} onChange={(e) => set({ payPct: e.target.value })} />) }] : []),
      { key: 'kmax', label: LABEL.rates.maxRate.text, info: index === 0 && topSpend != null ? `Top spend ${usd(topSpend)}` : undefined, node: (
        <TmsInput {...attrs(LABEL.rates.maxRate, 'maxRate')} inputMode="decimal" value={car.maxRate} disabled={disabled || locked} onChange={(e) => set({ maxRate: e.target.value })} />) },
    ]
  }

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

      <div className="tms-card-lines" data-testid="rates-lines">
        <div className="tms-card-line tms-card-line-head">
          <span>{LABEL.rates.release.text}</span>
          <span>{multi ? 'Paid to' : LABEL.rates.lineCarrier.text}</span>
          <span>{LABEL.rates.lineAccessorial.text}</span>
          <span>{LABEL.rates.lineCarrierAmount.text}</span>
          <span>{LABEL.rates.lineCustomerAmount.text}</span>
          <span />
        </div>
        <div className="tms-card-line" data-testid="rates-line-linehaul">
          <span />
          <span>{multi ? carrierLabel(slots[0], 0, ctx.directory.carriers, true) : carrierName}</span>
          <span>Line Haul</span>
          <span>{usd(preview.carriers[0]?.linehaulCents ?? 0)}</span>
          <span>{usd(preview.customerTotalLhCents)}</span>
          <span />
        </div>
        {slots.slice(1).map((s, k) => (
          <div key={s.slot} className="tms-card-line" data-testid={`rates-line-linehaul-${s.slot}`}>
            <span />
            <span>{carrierLabel(s, k + 1, ctx.directory.carriers, true)}</span>
            <span>Line Haul</span>
            <span>{usd(preview.carriers.find((c) => c.slot === s.slot)?.linehaulCents ?? 0)}</span>
            <span />
            <span />
          </div>
        ))}
        <datalist id="rates-charge-codes">
          {codes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </datalist>
        {value.lines.map((line, i) => {
          const target = paidSlotIndex(slots, paidToOf(line, slots))
          const paidTo = target >= 0 ? optionOf(slots[target]) : PAID_TO_NONE
          return (
            <div key={i} className="tms-card-line" data-testid={`rates-line-${i}`}>
              <TmsInput
                aria-label={`${LABEL.rates.release.text} ${i + 1}`}
                value={line.release}
                disabled={disabled || ratesLocked}
                onChange={(e) => setLine(i, { release: e.target.value })}
              />
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
              ) : <span>{carrierName}</span>}
              <TmsInput
                aria-label={`${LABEL.rates.lineAccessorial.text} ${i + 1}`}
                list="rates-charge-codes"
                value={line.code}
                disabled={disabled || ratesLocked}
                onChange={(e) => {
                  const code = e.target.value.toUpperCase()
                  const known = codes.find((c) => c.code === code)
                  setLine(i, { code, label: known?.label ?? line.label })
                }}
              />
              <TmsInput
                aria-label={`${LABEL.rates.lineCarrierAmount.text} ${i + 1}`}
                inputMode="decimal"
                value={line.carrierAmount}
                disabled={disabled || carrierLockedAll || (multi && paidTo === PAID_TO_NONE)}
                onChange={(e) => setLine(i, { carrierAmount: e.target.value })}
              />
              <TmsInput
                aria-label={`${LABEL.rates.lineCustomerAmount.text} ${i + 1}`}
                inputMode="decimal"
                value={line.customerAmount}
                disabled={disabled || ratesLocked}
                onChange={(e) => setLine(i, { customerAmount: e.target.value })}
              />
              <TmsIconButton
                shape="plain"
                aria-label={`Remove accessorial line ${i + 1}`}
                disabled={disabled || ratesLocked}
                onClick={() => onChange((p) => ({ ...p, lines: p.lines.filter((_, j) => j !== i) }))}
              >
                <Trash2 size={14} />
              </TmsIconButton>
            </div>
          )
        })}
        <div>
          <TmsButton
            size="sm"
            data-testid={LABEL.rates.addLine.testId}
            aria-label="Add accessorial line"
            disabled={disabled || ratesLocked}
            onClick={() => onChange((p) => ({ ...p, lines: [...p.lines, emptyAccessorialLine()] }))}
          >
            <Plus size={14} className="mr-1" /> {LABEL.rates.addLine.text}
          </TmsButton>
        </div>
      </div>
    </div>
  )
}

export const RatesSection = memo(RatesSectionImpl)
