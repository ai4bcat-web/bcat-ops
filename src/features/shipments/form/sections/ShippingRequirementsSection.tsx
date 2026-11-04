/**
 * Section 1: Shipping Requirements. Aljex's three field columns, the Temp / Pallet / Tarps
 * boxes, then the two-column flag grid. DOM order = `SHIPPING_TAB_ORDER`, then the flags.
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { TmsButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { calculateTotalsFromPicks } from '../mapping'
import { activeLoadCarrier, type FlagKey, type FormMode, type ShipmentFormValues, type TriState } from '../model'
import { LABEL, FLAG_COLUMNS } from '../labels'
import { EQUIPMENT_SUGGESTIONS, FORM_MODE_OPTIONS, FREIGHT_CLASSES, MAX, TRI_STATE_OPTIONS } from '../constants'
import type { SliceSectionProps } from '../sectionRegistry'
import { LField } from './formControls'
import { mayAutoFill, type RoutePointInput } from './milesEstimate'
import { getRouteMiles } from './routeMilesApi'
import { ctl, digitsOnly, disabledState, dollarText, issueFor, signedDigits } from './fieldUtil'

type Ship = ShipmentFormValues['ship']

export type ShippingRequirementsProps = SliceSectionProps<'ship'> & {
  mode: FormMode
  onModeChange: (mode: FormMode) => void
  /** `routeSignature(values.stops)`: changes only when the measurable route does ('' = not measurable yet). */
  routeKey: string
}

const triToValue = (v: TriState): string => (v === null ? 'na' : v ? 'yes' : 'no')
const valueToTri = (v: string): TriState => (v === 'yes' ? true : v === 'no' ? false : null)

const EQUIPMENT_LIST_ID = 'ship-equipment-suggestions'

function ShippingRequirementsImpl({ value, onChange, ctx, form, mode, onModeChange, routeKey }: ShippingRequirementsProps) {
  const [hint, setHint] = useState('')
  const base = disabledState(ctx)
  const set = (patch: Partial<Ship>) => onChange(patch)
  const txt = (key: keyof Ship, clean: (s: string) => string = (s) => s) => (e: ChangeEvent<HTMLInputElement>) =>
    set({ [key]: clean(e.target.value) } as Partial<Ship>)
  const err = (testId: string) => issueFor(ctx, 'shipping', testId)

  const modeKnown = FORM_MODE_OPTIONS.some((o) => o.value === mode)
  const modeLock = disabledState(ctx, 'mode')
  const equipLock = disabledState(ctx, 'equipment')
  const milesLock = disabledState(ctx, 'customerMiles')
  const weightLock = disabledState(ctx, 'weight')

  const revCode = value.revSubdivision || value.revDivision
  const rows = ctx.divisions.filter((r) => r.division.active || r.division.code === revCode)
  const pickDivision = (code: string) => {
    if (!code) { set({ revDivision: '', revSubdivision: '' }); return }
    const byId = new Map(ctx.divisions.map((r) => [r.division.id, r.division]))
    let node = ctx.divisions.find((r) => r.division.code === code)?.division
    if (!node) return
    if (!node.parentId) { set({ revDivision: node.code, revSubdivision: '' }); return }
    const chosen = node.code
    for (let guard = 0; node?.parentId && guard < 20; guard++) node = byId.get(node.parentId)
    set({ revDivision: node?.code ?? chosen, revSubdivision: chosen })
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
  // Customer Miles / Truck Miles follow the route until a person types over them.
  const [milesNote, setMilesNote] = useState('')
  const lastAuto = useRef({ customer: '', truck: '' })
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })
  const milesBlocked = value.disableMileage || milesLock.disabled
  useEffect(() => {
    if (!routeKey || milesBlocked) return
    let alive = true
    const timer = setTimeout(() => {
      getRouteMiles(JSON.parse(routeKey) as RoutePointInput[])
        .then(({ miles, source, error }) => {
          if (!alive) return
          if (error) { setMilesNote('Could not measure the route — type the miles'); return }
          if (miles === null) return
          const next = String(miles)
          onChangeRef.current((prev) => {
            const patch: Partial<Ship> = {}
            if (mayAutoFill(prev.customerMiles, lastAuto.current.customer)) patch.customerMiles = next
            if (mayAutoFill(prev.truckMiles, lastAuto.current.truck)) patch.truckMiles = next
            lastAuto.current = {
              customer: patch.customerMiles ?? lastAuto.current.customer,
              truck: patch.truckMiles ?? lastAuto.current.truck,
            }
            return { ...prev, ...patch }
          })
          setMilesNote(source === 'google' ? 'Miles from the stop addresses' : 'est. — straight line × 1.2')
        })
    }, 600)
    return () => { alive = false; clearTimeout(timer) }
  }, [routeKey, milesBlocked])

  const activeCarrier = activeLoadCarrier(ctx.bundle)
  const flagChecked = (k: FlagKey) => value.flags[k]
  const toggleFlag = (k: FlagKey, on: boolean) => {
    if (k === 'tonu') { if (activeCarrier) ctx.actions.openTonu(); return }
    onChange((prev) => ({ ...prev, flags: { ...prev.flags, [k]: on } }))
  }

  const check = (def: { text: string; testId: string; help?: string }, checked: boolean, on: (v: boolean) => void, disabled: boolean, title?: string) => (
    <label className="ship-check" data-disabled={disabled} title={title}>
      <input type="checkbox" aria-label={def.text} data-testid={def.testId} checked={checked} disabled={disabled} onChange={(e) => on(e.target.checked)} />
      {def.text}
    </label>
  )

  const tempOff = !value.temp.on
  const flag = (k: FlagKey) => {
    const def = LABEL.flags[k]
    const tonu = k === 'tonu'
    const disabled = base.disabled || (tonu && (ctx.mode === 'create' || !activeCarrier || ctx.locked.voided))
    return (
      <div key={k}>
        {check(def, flagChecked(k), (v) => toggleFlag(k, v), disabled, tonu && disabled ? LABEL.flags.tonu.help : base.title)}
      </div>
    )
  }

  return (
    <div className="ship-req-grid" data-testid="section-shipping-body">
      <div className="ship-req-col">
        <LField def={LABEL.shipping.mode}>
          <TmsSelect {...ctl(LABEL.shipping.mode)} value={mode} disabled={modeLock.disabled} title={modeLock.title} onChange={(e) => onModeChange(e.target.value as FormMode)}>
            {!modeKnown && <option value={mode} disabled>{mode}</option>}
            {FORM_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </TmsSelect>
        </LField>
        <LField def={LABEL.shipping.equipmentType} error={err(LABEL.shipping.equipmentType.testId)}>
          <TmsInput {...ctl(LABEL.shipping.equipmentType)} list={EQUIPMENT_LIST_ID} maxLength={MAX.equipment} value={value.equipmentType} disabled={equipLock.disabled} title={equipLock.title} onChange={txt('equipmentType')} />
        </LField>
        <datalist id={EQUIPMENT_LIST_ID}>{EQUIPMENT_SUGGESTIONS.map((e) => <option key={e} value={e} />)}</datalist>
        <LField def={LABEL.shipping.revDivision} error={err(LABEL.shipping.revDivision.testId)}>
          <TmsSelect {...ctl(LABEL.shipping.revDivision)} value={revCode} disabled={base.disabled} onChange={(e) => pickDivision(e.target.value)}>
            <option value="" />
            {rows.map((r) => (
              <option key={r.division.id} value={r.division.code}>{`${'\u00a0\u00a0'.repeat(r.depth)}${r.division.name}`}</option>
            ))}
          </TmsSelect>
        </LField>
        <LField def={LABEL.shipping.office}>
          <TmsInput {...ctl(LABEL.shipping.office)} readOnly className="ship-readonly" value={value.officeLabel || 'No Office'} title={LABEL.shipping.office.help} />
        </LField>
        <LField def={LABEL.shipping.customerMiles} error={err(LABEL.shipping.customerMiles.testId)}>
          <TmsInput {...ctl(LABEL.shipping.customerMiles)} inputMode="numeric" value={value.customerMiles} disabled={milesLock.disabled} title={milesLock.title} onChange={txt('customerMiles', digitsOnly)} />
        </LField>
        <LField def={LABEL.shipping.truckMiles} error={err(LABEL.shipping.truckMiles.testId)}>
          <TmsInput {...ctl(LABEL.shipping.truckMiles)} inputMode="numeric" value={value.truckMiles} disabled={base.disabled} onChange={txt('truckMiles', digitsOnly)} />
        </LField>
        {milesNote && !value.disableMileage && <span className="ship-hint" data-testid="f-shipping-milesSource">{milesNote}</span>}
        {hint && <span className="ship-hint" role="status" data-testid="f-shipping-hint">{hint}</span>}
      </div>

      <div className="ship-req-col">
        <LField def={LABEL.shipping.footage}>
          <TmsInput {...ctl(LABEL.shipping.footage)} inputMode="numeric" value={value.footage} disabled={base.disabled} onChange={txt('footage', digitsOnly)} />
        </LField>
        <LField def={LABEL.shipping.pieces}>
          <TmsInput {...ctl(LABEL.shipping.pieces)} inputMode="numeric" value={value.pieces} disabled={base.disabled} onChange={txt('pieces', digitsOnly)} />
        </LField>
        <LField def={LABEL.shipping.weightLbs} error={err(LABEL.shipping.weightLbs.testId)}>
          <TmsInput {...ctl(LABEL.shipping.weightLbs)} inputMode="numeric" value={value.weightLbs} disabled={weightLock.disabled} title={weightLock.title} onChange={txt('weightLbs', digitsOnly)} />
        </LField>
        <LField def={LABEL.shipping.billableWeightLbs}>
          <TmsInput {...ctl(LABEL.shipping.billableWeightLbs)} inputMode="numeric" value={value.billableWeightLbs} disabled={base.disabled} onChange={txt('billableWeightLbs', digitsOnly)} />
        </LField>
        <TmsButton type="button" variant="primary" size="sm" {...ctl(LABEL.shipping.calculateTotals)} disabled={weightLock.disabled} onClick={calculate}>
          {LABEL.shipping.calculateTotals.text}
        </TmsButton>
        {check(LABEL.shipping.disableMileage, value.disableMileage, (v) => set({ disableMileage: v }), base.disabled)}
      </div>

      <div className="ship-req-col">
        <LField def={LABEL.shipping.freightClass}>
          <TmsSelect {...ctl(LABEL.shipping.freightClass)} value={value.freightClass} disabled={base.disabled} onChange={(e) => set({ freightClass: e.target.value })}>
            <option value="" />
            {value.freightClass && !(FREIGHT_CLASSES as readonly string[]).includes(value.freightClass) && <option value={value.freightClass}>{value.freightClass}</option>}
            {FREIGHT_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </TmsSelect>
        </LField>
        <LField def={LABEL.shipping.description} error={err(LABEL.shipping.description.testId)}>
          <TmsInput {...ctl(LABEL.shipping.description)} maxLength={MAX.description} value={value.description} disabled={base.disabled} onChange={txt('description')} />
        </LField>
        <LField def={LABEL.shipping.declaredValue}>
          <TmsInput {...ctl(LABEL.shipping.declaredValue)} inputMode="decimal" value={value.declaredValue} disabled={base.disabled} onChange={txt('declaredValue', dollarText)} />
        </LField>
        <LField def={LABEL.shipping.liftgate}>
          <TmsSelect {...ctl(LABEL.shipping.liftgate)} value={triToValue(value.liftgate)} disabled={base.disabled} onChange={(e) => set({ liftgate: valueToTri(e.target.value) })}>
            {TRI_STATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </TmsSelect>
        </LField>
        <LField def={LABEL.shipping.inside}>
          <TmsSelect {...ctl(LABEL.shipping.inside)} value={triToValue(value.inside)} disabled={base.disabled} onChange={(e) => set({ inside: valueToTri(e.target.value) })}>
            {TRI_STATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </TmsSelect>
        </LField>
      </div>

      <div className="ship-req-boxes">
        <div className="ship-req-box">
          {check(LABEL.shipping.tempControl, value.temp.on, (on) => set({ temp: on ? { ...value.temp, on } : { on: false, unit: 'F', min: '', max: '', preCool: '' } }), base.disabled)}
          <LField def={LABEL.shipping.tempType}>
            <TmsSelect {...ctl(LABEL.shipping.tempType)} value={value.temp.unit} disabled={base.disabled || tempOff} onChange={(e) => set({ temp: { ...value.temp, unit: e.target.value as 'F' | 'C' } })}>
              <option value="F">F</option>
              <option value="C">C</option>
            </TmsSelect>
          </LField>
          <LField def={LABEL.shipping.tempMin}>
            <TmsInput {...ctl(LABEL.shipping.tempMin)} inputMode="numeric" placeholder="#°" value={value.temp.min} disabled={base.disabled || tempOff} onChange={(e) => set({ temp: { ...value.temp, min: signedDigits(e.target.value) } })} />
          </LField>
          <LField def={LABEL.shipping.tempMax}>
            <TmsInput {...ctl(LABEL.shipping.tempMax)} inputMode="numeric" placeholder="#°" value={value.temp.max} disabled={base.disabled || tempOff} onChange={(e) => set({ temp: { ...value.temp, max: signedDigits(e.target.value) } })} />
          </LField>
          <LField def={LABEL.shipping.tempPreCool}>
            <TmsInput {...ctl(LABEL.shipping.tempPreCool)} inputMode="numeric" placeholder="#°" value={value.temp.preCool} disabled={base.disabled || tempOff} onChange={(e) => set({ temp: { ...value.temp, preCool: signedDigits(e.target.value) } })} />
          </LField>
        </div>
        <div className="ship-req-box">
          {check(LABEL.shipping.palletExchange, value.palletExchange.on, (on) => set({ palletExchange: on ? { ...value.palletExchange, on } : { on: false, palletsIn: '', palletsOut: '' } }), base.disabled)}
          <LField def={LABEL.shipping.palletsIn}>
            <TmsInput {...ctl(LABEL.shipping.palletsIn)} inputMode="numeric" value={value.palletExchange.palletsIn} disabled={base.disabled || !value.palletExchange.on} onChange={(e) => set({ palletExchange: { ...value.palletExchange, palletsIn: digitsOnly(e.target.value) } })} />
          </LField>
          <LField def={LABEL.shipping.palletsOut}>
            <TmsInput {...ctl(LABEL.shipping.palletsOut)} inputMode="numeric" value={value.palletExchange.palletsOut} disabled={base.disabled || !value.palletExchange.on} onChange={(e) => set({ palletExchange: { ...value.palletExchange, palletsOut: digitsOnly(e.target.value) } })} />
          </LField>
        </div>
        <div className="ship-req-box">
          {check(LABEL.shipping.tarps, value.tarps.on, (on) => set({ tarps: on ? { ...value.tarps, on } : { on: false, size: '' } }), base.disabled)}
          <LField def={LABEL.shipping.tarpSize}>
            <TmsInput {...ctl(LABEL.shipping.tarpSize)} maxLength={MAX.shortText} value={value.tarps.size} disabled={base.disabled || !value.tarps.on} onChange={(e) => set({ tarps: { ...value.tarps, size: e.target.value } })} />
          </LField>
        </div>
      </div>

      <div className="ship-flag-grid" data-testid="f-shipping-flags">
        <div className="ship-flag-col">{FLAG_COLUMNS.left.map(flag)}</div>
        <div className="ship-flag-col">{FLAG_COLUMNS.right.map(flag)}</div>
      </div>
    </div>
  )
}

export const ShippingRequirementsSection = memo(ShippingRequirementsImpl)
