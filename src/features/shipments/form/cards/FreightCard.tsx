/**
 * Card 1: Freight (Step AR; first card since feedback 7). Division (required, first: the ownership division and the revenue tag in one pick), Shipment type (required; picking
 * one fills its default equipment and chips where still empty), Equipment, Weight (+ billable), Pieces, Footage,
 * Description, Class, Declared Value and the customer's reference; then the REQUIREMENTS chip
 * bar that replaces the AH checkbox grid. A chip toggles the same `ship.flags` key (or the
 * Temp / Tarps / Pallet exchange / Liftgate / Inside field it stands for); Temp, Tarps and
 * Pallet exchange reveal their sub-fields inline. "Calculate totals from picks" and "Disable
 * mileage" sit at the card foot. Aljex wording and `f-shipping-*` test ids come from labels.ts;
 * our underlying name is the chip's tooltip.
 */
import { useMemo, useState } from 'react'
import { TmsButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { EQUIPMENT_SUGGESTIONS, FREIGHT_CLASSES, MAX } from '../constants'
import { LABEL, type LabelDef } from '../labels'
import { calculateTotalsFromPicks } from '../mapping'
import { SHIPMENT_TYPES } from '@/lib/shipmentTypes'
import { activeLoadCarrier, isLocked, lockReason, type FlagKey, type ShipmentFormValues } from '../model'
import { applyShipmentType, typeForDivisionChange } from '../shipmentType'
import { ctl, digitsOnly, disabledState, dollarText, issueFor, signedDigits } from '../sections/fieldUtil'
import { FieldGrid } from '../fieldGrid'
import { LField } from '../sections/formControls'
import { type CardProps, sliceOf } from './cardRegistry'
import './cards.css'

type Ship = ShipmentFormValues['ship']

const EQUIPMENT_LIST_ID = 'ship-equipment-suggestions'

/** The chip bar, in the spec's order. `flag` chips map 1:1 onto `ship.flags`; the rest onto their own fields. */
type ChipKey = FlagKey | 'tarps' | 'liftgate' | 'inside' | 'tempControl' | 'palletExchange'
const CHIP_ORDER: readonly ChipKey[] = [
  'hazmat', 'team', 'tarps', 'liftgate', 'inside', 'tempControl', 'palletExchange', 'permits', 'fsma', 'oversized',
  'escorts', 'seal', 'blind', 'customsBonded', 'osd', 'strapsChains', 'noBroker', 'hot', 'labor', 'highRisk',
  'massRelease', 'tonu',
] as const

function chipDef(key: ChipKey): LabelDef {
  return key in LABEL.flags ? LABEL.flags[key as FlagKey] : LABEL.shipping[key as 'tarps' | 'liftgate' | 'inside' | 'tempControl' | 'palletExchange']
}

export function FreightCard({ values, update, ctx, form }: CardProps) {
  const value = values.ship
  const onChange = useMemo(() => sliceOf(update, 'ship'), [update])
  const [hint, setHint] = useState('')
  const base = disabledState(ctx)
  const equipLock = disabledState(ctx, 'equipment')
  const weightLock = disabledState(ctx, 'weight')
  const err = (testId: string) => issueFor(ctx, 'shipping', testId)
  const set = (patch: Partial<Ship>) => onChange(patch)
  const txt = (key: keyof Ship, clean: (s: string) => string = (s) => s) => (e: { target: { value: string } }) =>
    set({ [key]: clean(e.target.value) } as Partial<Ship>)

  const revCode = value.revSubdivision || value.revDivision
  const rows = ctx.divisions.filter((r) => r.division.active || r.division.code === revCode)
  const setDivision = (revDivision: string, revSubdivision: string) =>
    update((p) => typeForDivisionChange(p, { ...p, ship: { ...p.ship, revDivision, revSubdivision } }))
  const typeLocked = isLocked(ctx.locked, 'mode')
  const typeGroups = [...new Set(SHIPMENT_TYPES.map((t) => t.group))]
  const pickDivision = (code: string) => {
    if (!code) { setDivision('', ''); return }
    const byId = new Map(ctx.divisions.map((r) => [r.division.id, r.division]))
    let node = ctx.divisions.find((r) => r.division.code === code)?.division
    if (!node) return
    if (!node.parentId) { setDivision(node.code, ''); return }
    const chosen = node.code
    for (let guard = 0; node?.parentId && guard < 20; guard++) node = byId.get(node.parentId)
    setDivision(node?.code ?? chosen, chosen)
  }

  const calculate = () => {
    const t = calculateTotalsFromPicks(form.getValues().stops)
    if (t.picks === 0 || (t.pieces === null && t.weightLbs === null)) {
      setHint('No pick has pieces or weight to count.')
      return
    }
    set({
      ...(t.pieces !== null ? { pieces: String(t.pieces) } : {}),
      ...(t.weightLbs !== null ? { weightLbs: String(t.weightLbs) } : {}),
    })
    setHint(`${t.picks} ${t.picks === 1 ? 'pick' : 'picks'} counted`)
  }

  const activeCarrier = activeLoadCarrier(ctx.bundle)
  const isOn = (k: ChipKey): boolean => {
    if (k === 'tarps') return value.tarps.on
    if (k === 'tempControl') return value.temp.on
    if (k === 'palletExchange') return value.palletExchange.on
    if (k === 'liftgate' || k === 'inside') return value[k] === true
    return value.flags[k]
  }
  const toggle = (k: ChipKey, on: boolean) => {
    switch (k) {
      case 'tarps': set({ tarps: on ? { ...value.tarps, on } : { on: false, size: '' } }); return
      case 'tempControl': set({ temp: on ? { ...value.temp, on } : { on: false, unit: 'F', min: '', max: '', preCool: '' } }); return
      case 'palletExchange': set({ palletExchange: on ? { ...value.palletExchange, on } : { on: false, palletsIn: '', palletsOut: '' } }); return
      // Tri-state: a chip is "Yes"; turning it off returns to N/A (an explicit "No" stays until toggled).
      case 'liftgate': case 'inside': set({ [k]: on ? true : null } as Partial<Ship>); return
      case 'tonu': if (activeCarrier) ctx.actions.openTonu(); return
      default: onChange((prev) => ({ ...prev, flags: { ...prev.flags, [k]: on } }))
    }
  }

  const chip = (k: ChipKey) => {
    const def = chipDef(k)
    const tonu = k === 'tonu'
    const disabled = base.disabled || (tonu && (ctx.mode === 'create' || !activeCarrier || ctx.locked.voided))
    const on = isOn(k)
    const title = (tonu && disabled ? LABEL.flags.tonu.help : base.title) ?? ('help' in def ? def.help : undefined)
    return (
      <label key={k} className="tms-card-chip" data-on={on} data-disabled={disabled} title={title}>
        <input type="checkbox" className="tms-card-chip-input" aria-label={def.text} data-testid={def.testId} checked={on} disabled={disabled} onChange={(e) => toggle(k, e.target.checked)} />
        {def.text}
      </label>
    )
  }

  const tempOff = !value.temp.on
  return (
    <div className="tms-card-body-stack" data-testid="section-freight-body">
      <FieldGrid>
        <LField span={3} def={LABEL.shipping.revDivision} error={err(LABEL.shipping.revDivision.testId)} hint={LABEL.shipping.revDivision.help}>
          <TmsSelect {...ctl(LABEL.shipping.revDivision)} value={revCode} disabled={base.disabled} onChange={(e) => pickDivision(e.target.value)}>
            <option value="" />
            {rows.map((r) => (
              <option key={r.division.id} value={r.division.code}>{`${'\u00a0\u00a0'.repeat(r.depth)}${r.division.name}`}</option>
            ))}
          </TmsSelect>
        </LField>
        <LField span={3} def={LABEL.shipping.shipmentType} error={err(LABEL.shipping.shipmentType.testId)}>
          <TmsSelect
            {...ctl(LABEL.shipping.shipmentType)} aria-label={LABEL.shipping.shipmentType.text} value={values.shipmentType}
            disabled={base.disabled || typeLocked} title={typeLocked ? lockReason(ctx.locked, 'mode') : undefined}
            onChange={(e) => update((p) => applyShipmentType(p, e.target.value))}
          >
            {!SHIPMENT_TYPES.some((t) => t.key === values.shipmentType) && <option value={values.shipmentType} disabled>{values.shipmentType || 'Select…'}</option>}
            {typeGroups.map((g) => (
              <optgroup key={g} label={g}>
                {SHIPMENT_TYPES.filter((t) => t.group === g).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </optgroup>
            ))}
          </TmsSelect>
        </LField>
        <LField span={3} def={LABEL.shipping.equipmentType} error={err(LABEL.shipping.equipmentType.testId)}>
          <TmsInput {...ctl(LABEL.shipping.equipmentType)} list={EQUIPMENT_LIST_ID} maxLength={MAX.equipment} value={value.equipmentType} disabled={equipLock.disabled} title={equipLock.title} onChange={txt('equipmentType')} />
        </LField>
        <datalist id={EQUIPMENT_LIST_ID}>{EQUIPMENT_SUGGESTIONS.map((e) => <option key={e} value={e} />)}</datalist>
        <LField span={3} def={LABEL.shipping.weightLbs} error={err(LABEL.shipping.weightLbs.testId)}>
          <TmsInput {...ctl(LABEL.shipping.weightLbs)} inputMode="numeric" value={value.weightLbs} disabled={weightLock.disabled} title={weightLock.title} onChange={txt('weightLbs', digitsOnly)} />
        </LField>
        <LField span={3} def={LABEL.shipping.billableWeightLbs}>
          <TmsInput {...ctl(LABEL.shipping.billableWeightLbs)} inputMode="numeric" value={value.billableWeightLbs} disabled={base.disabled} onChange={txt('billableWeightLbs', digitsOnly)} />
        </LField>
        <LField span={3} def={LABEL.shipping.pieces}>
          <TmsInput {...ctl(LABEL.shipping.pieces)} inputMode="numeric" value={value.pieces} disabled={base.disabled} onChange={txt('pieces', digitsOnly)} />
        </LField>
        <LField span={3} def={LABEL.shipping.footage}>
          <TmsInput {...ctl(LABEL.shipping.footage)} inputMode="numeric" value={value.footage} disabled={base.disabled} onChange={txt('footage', digitsOnly)} />
        </LField>
        <LField span={3} def={LABEL.shipping.freightClass}>
          <TmsSelect {...ctl(LABEL.shipping.freightClass)} value={value.freightClass} disabled={base.disabled} onChange={(e) => set({ freightClass: e.target.value })}>
            <option value="" />
            {value.freightClass && !(FREIGHT_CLASSES as readonly string[]).includes(value.freightClass) && <option value={value.freightClass}>{value.freightClass}</option>}
            {FREIGHT_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </TmsSelect>
        </LField>
        <LField span={9} def={LABEL.shipping.description} error={err(LABEL.shipping.description.testId)} hint={LABEL.shipping.description.help}>
          <TmsInput {...ctl(LABEL.shipping.description)} maxLength={MAX.description} value={value.description} disabled={base.disabled} onChange={txt('description')} />
        </LField>
        <LField span={3} narrow={12} def={LABEL.shipping.declaredValue}>
          <TmsInput {...ctl(LABEL.shipping.declaredValue)} inputMode="decimal" value={value.declaredValue} disabled={base.disabled} onChange={txt('declaredValue', dollarText)} />
        </LField>
        <div className="tms-card-req tms-fg-chips" role="group" aria-label="Requirements" data-testid="f-shipping-flags">
          <span className="tms-card-req-title">Requirements</span>
          <div className="tms-card-chips">{CHIP_ORDER.map(chip)}</div>
        </div>
      </FieldGrid>

      {(value.temp.on || value.palletExchange.on || value.tarps.on) && (
        <div className="tms-card-req-sub" data-testid="f-shipping-subfields">
          {value.temp.on && (
            <FieldGrid>
              <LField span={3} def={LABEL.shipping.tempType}>
                <TmsSelect {...ctl(LABEL.shipping.tempType)} value={value.temp.unit} disabled={base.disabled || tempOff} onChange={(e) => set({ temp: { ...value.temp, unit: e.target.value as 'F' | 'C' } })}>
                  <option value="F">F</option>
                  <option value="C">C</option>
                </TmsSelect>
              </LField>
              <LField span={3} def={LABEL.shipping.tempMin}>
                <TmsInput {...ctl(LABEL.shipping.tempMin)} inputMode="numeric" placeholder="#°" value={value.temp.min} disabled={base.disabled} onChange={(e) => set({ temp: { ...value.temp, min: signedDigits(e.target.value) } })} />
              </LField>
              <LField span={3} def={LABEL.shipping.tempMax}>
                <TmsInput {...ctl(LABEL.shipping.tempMax)} inputMode="numeric" placeholder="#°" value={value.temp.max} disabled={base.disabled} onChange={(e) => set({ temp: { ...value.temp, max: signedDigits(e.target.value) } })} />
              </LField>
              <LField span={3} def={LABEL.shipping.tempPreCool}>
                <TmsInput {...ctl(LABEL.shipping.tempPreCool)} inputMode="numeric" placeholder="#°" value={value.temp.preCool} disabled={base.disabled} onChange={(e) => set({ temp: { ...value.temp, preCool: signedDigits(e.target.value) } })} />
              </LField>
            </FieldGrid>
          )}
          {value.palletExchange.on && (
            <FieldGrid>
              <LField span={6} def={LABEL.shipping.palletsIn}>
                <TmsInput {...ctl(LABEL.shipping.palletsIn)} inputMode="numeric" value={value.palletExchange.palletsIn} disabled={base.disabled} onChange={(e) => set({ palletExchange: { ...value.palletExchange, palletsIn: digitsOnly(e.target.value) } })} />
              </LField>
              <LField span={6} def={LABEL.shipping.palletsOut}>
                <TmsInput {...ctl(LABEL.shipping.palletsOut)} inputMode="numeric" value={value.palletExchange.palletsOut} disabled={base.disabled} onChange={(e) => set({ palletExchange: { ...value.palletExchange, palletsOut: digitsOnly(e.target.value) } })} />
              </LField>
            </FieldGrid>
          )}
          {value.tarps.on && (
            <FieldGrid>
              <LField span={12} def={LABEL.shipping.tarpSize}>
                <TmsInput {...ctl(LABEL.shipping.tarpSize)} maxLength={MAX.shortText} value={value.tarps.size} disabled={base.disabled} onChange={(e) => set({ tarps: { ...value.tarps, size: e.target.value } })} />
              </LField>
            </FieldGrid>
          )}
        </div>
      )}

      <div className="tms-fg-toolbar" data-testid="f-shipping-toolbar">
        {hint && <span className="tms-muted text-xs" role="status" data-testid="f-shipping-hint">{hint}</span>}
        <TmsButton type="button" size="sm" {...ctl(LABEL.shipping.calculateTotals)} disabled={weightLock.disabled} onClick={calculate}>
          {LABEL.shipping.calculateTotals.text}
        </TmsButton>
        <label className="ship-check">
          <input
            type="checkbox" aria-label={LABEL.shipping.disableMileage.text} data-testid={LABEL.shipping.disableMileage.testId}
            checked={value.disableMileage} disabled={base.disabled} onChange={(e) => set({ disableMileage: e.target.checked })}
          />
          {LABEL.shipping.disableMileage.text}
        </label>
      </div>
    </div>
  )
}
