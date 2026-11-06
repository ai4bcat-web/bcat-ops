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
import { financialPreview } from '../mapping'
import { isLocked, lockReason, type AccessorialLine, type CarrierRateKind, type FormRateKind } from '../model'
import type { RatesSectionProps } from '../sectionRegistry'
import { Field, FieldGrid, spread } from '../fieldGrid'
import { fieldAttrs } from './fieldAttrs'
import '../cards/moneyCards.css'

const usd = (cents: number) => `$${formatCents(cents)}`

function emptyAccessorialLine(): AccessorialLine {
  return { id: '', carrierLineId: '', release: '', carrierKey: '', code: '', label: '', carrierAmount: '', customerAmount: '', note: '' }
}

interface RateField { key: string; label: string; info?: string; node: ReactNode }

/** A titled row of rate fields on the shared 12-column grid; the count (hours, pay %) decides the spans so every row stays flush. */
function RateRow({ title, label, fields }: { title: string; label: string; fields: RateField[] }) {
  const { wide, narrow } = spread(fields.length)
  return (
    <div className="tms-card-rate-row" role="group" aria-label={label}>
      <span className="tms-card-rate-row-title">{title}</span>
      <FieldGrid>
        {fields.map((f, i) => <Field key={f.key} label={f.label} info={f.info} span={wide[i]!} narrow={narrow[i]}>{f.node}</Field>)}
      </FieldGrid>
    </div>
  )
}

function RatesSectionImpl({ value, onChange, ctx, ship, form }: RatesSectionProps) {
  const ratesLocked = isLocked(ctx.locked, 'rates')
  const carrierLocked = ratesLocked || isLocked(ctx.locked, 'carrierRates')
  const disabled = ctx.busy
  const lockNote = lockReason(ctx.locked, 'rates') ?? lockReason(ctx.locked, 'carrierRates')

  // Rates price off Customer Miles / Weight (`ship`), which arrive with this slice; the rest of
  // the form is not read by pricing. `getValues` is read at render only to complete the object.
  const preview = useMemo(
    () => financialPreview({ ...form.getValues(), rates: value, ship }, ctx.customer, ctx.settings),
    [form, value, ship, ctx.customer, ctx.settings],
  )

  const cust = value.customer
  const car = value.carrier
  const codes = ctx.settings?.chargeCodes ?? []
  const fscBoth = value.fscPercent.trim() !== '' && value.fscPerMile.trim() !== ''
  const carrierName = ctx.directory.carriers.find((c) => c.id === ctx.bundle?.loadCarriers.find((lc) => lc.status === 'ACTIVE')?.carrierId)?.name ?? ''

  const setCustomer = (patch: Partial<typeof cust>) => onChange((p) => ({ ...p, customer: { ...p.customer, ...patch } }))
  const setCarrier = (patch: Partial<typeof car>) => onChange((p) => ({ ...p, carrier: { ...p.carrier, ...patch } }))
  const setLine = (i: number, patch: Partial<AccessorialLine>) =>
    onChange((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }))

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
  const carrierFields: RateField[] = [
    { key: 'kt', label: LABEL.rates.carrierRateType.text, node: (
      <TmsSelect
        {...fieldAttrs(LABEL.rates.carrierRateType)} value={car.rateType} disabled={disabled || carrierLocked}
        onChange={(e) => setCarrier({ rateType: e.target.value as CarrierRateKind })}
        options={CARRIER_RATE_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />) },
    ...(car.rateType === 'PER_HOUR' ? [{ key: 'kh', label: LABEL.rates.carrierHours.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.carrierHours)} type="number" min={0} step="any" value={car.hours} disabled={disabled || carrierLocked} onChange={(e) => setCarrier({ hours: e.target.value })} />) }] : []),
    { key: 'klh', label: LABEL.rates.carrierLhRate.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.carrierLhRate)} inputMode="decimal" value={car.lhRate} disabled={disabled || carrierLocked || car.rateType === 'PCT_OF_CUSTOMER'} onChange={(e) => setCarrier({ lhRate: e.target.value })} />) },
    { key: 'ktl', label: LABEL.rates.carrierTotalLh.text, node: <TmsInput {...fieldAttrs(LABEL.rates.carrierTotalLh)} readOnly value={usd(preview.carrierTotalLhCents)} /> },
    ...(car.rateType === 'PCT_OF_CUSTOMER' ? [{ key: 'kp', label: LABEL.rates.payPct.text, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.payPct)} inputMode="decimal" value={car.payPct} disabled={disabled || carrierLocked} onChange={(e) => setCarrier({ payPct: e.target.value })} />) }] : []),
    { key: 'kmax', label: LABEL.rates.maxRate.text, info: topSpend != null ? `Top spend ${usd(topSpend)}` : undefined, node: (
      <TmsInput {...fieldAttrs(LABEL.rates.maxRate)} inputMode="decimal" value={car.maxRate} disabled={disabled || carrierLocked} onChange={(e) => setCarrier({ maxRate: e.target.value })} />) },
  ]

  return (
    <div className="tms-card-rates" data-testid="section-rates-body">
      {lockNote && <p className="tms-muted text-xs" data-testid="rates-lock-note">{lockNote}</p>}

      <RateRow title="Customer" label="Customer rate" fields={customerFields} />
      {fscBoth && (
        <p className="tms-card-rate-note" data-testid="rates-fsc-note">
          Use FSC % or FSC/Mile, not both — FSC/Mile wins.
        </p>
      )}
      <RateRow title="Carrier" label="Carrier rate" fields={carrierFields} />

      <div className="tms-card-lines" data-testid="rates-lines">
        <div className="tms-card-line tms-card-line-head">
          <span>{LABEL.rates.release.text}</span>
          <span>{LABEL.rates.lineCarrier.text}</span>
          <span>{LABEL.rates.lineAccessorial.text}</span>
          <span>{LABEL.rates.lineCarrierAmount.text}</span>
          <span>{LABEL.rates.lineCustomerAmount.text}</span>
          <span />
        </div>
        <div className="tms-card-line" data-testid="rates-line-linehaul">
          <span />
          <span>{carrierName}</span>
          <span>Line Haul</span>
          <span>{usd(preview.carrierTotalLhCents)}</span>
          <span>{usd(preview.customerTotalLhCents)}</span>
          <span />
        </div>
        <datalist id="rates-charge-codes">
          {codes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </datalist>
        {value.lines.map((line, i) => (
          <div key={i} className="tms-card-line" data-testid={`rates-line-${i}`}>
            <TmsInput
              aria-label={`${LABEL.rates.release.text} ${i + 1}`}
              value={line.release}
              disabled={disabled || ratesLocked}
              onChange={(e) => setLine(i, { release: e.target.value })}
            />
            <span>{line.carrierKey || carrierName}</span>
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
              disabled={disabled || carrierLocked}
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
        ))}
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
