/**
 * Sections 3-4: Pick Up and Consignee (and every inserted stop, via `StopFields`).
 *
 * Name is a directory type-ahead over the locations in `ctx.directory`; it also accepts text
 * that matches nothing (it is matched or filed by `linkStopsToDirectory` at save time, never
 * here). Picking a location prefills address, contact and hours. The pencil opens the
 * explicit "Add location" dialog: a Location is only ever created from that dialog.
 */
import { memo, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
import { TmsIconButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { createLocation } from '@/lib/apiClient'
import { requiresApptProofs } from '@/lib/apptQueue'
import { findLocationMatches } from '@/lib/tmsDirectory'
import type { LocationRecord } from '@/types/tms'
import { COUNTRIES, MAX, US_STATES } from '../constants'
import type { LabelDef } from '../labels'
import type { FormStop } from '../model'
import type { FormCtx } from '../sectionProps'
import type { StopSectionProps } from '../sectionRegistry'
import { LField } from './formControls'
import { type StopKey, stopDef, stopPatchFromLocation, ctl, digitsOnly, disabledState, issueFor, maskPhone } from './fieldUtil'

interface StopFieldsProps {
  stop: FormStop
  /** Test-id infix: `pickup`, `consignee`, `stop-2`. */
  prefix: string
  /** Pick Up (the first stop): Name and Ready are Aljex-red. */
  required: boolean
  onChange: (patch: Partial<FormStop> | ((prev: FormStop) => FormStop)) => void
  ctx: FormCtx
}

export function StopFields({ stop, prefix, required, onChange, ctx }: StopFieldsProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const base = disabledState(ctx)
  const stopLock = ctx.locked.stops[stop.id]
  const placeLocked = base.disabled || Boolean(stopLock)
  const section = prefix === 'pickup' ? 'pickup' : prefix === 'consignee' ? 'consignee' : 'picks'
  const d = (key: StopKey, req = false) => stopDef(prefix, key, req)
  const err = (def: LabelDef) => issueFor(ctx, section, def.testId)
  const isBatory = requiresApptProofs({ customer: ctx.customer?.name ?? '', customerApptWorkflow: ctx.customer?.apptWorkflow ?? null })

  const matches = useMemo(
    () => (query.trim().length < 2 ? [] : findLocationMatches({ name: query, city: stop.city || undefined }, ctx.directory.locations).slice(0, 8)),
    [query, stop.city, ctx.directory.locations],
  )

  const nameDef = d('name', required)
  const typeName = (text: string) => {
    setQuery(text)
    setOpen(true)
    const linked = stop.locationId ? ctx.directory.locations.find((l) => l.id === stop.locationId) : null
    onChange(linked && linked.name !== text ? { name: text, locationId: '', geo: null } : { name: text })
  }
  const choose = (loc: LocationRecord) => {
    onChange(stopPatchFromLocation(loc))
    setQuery('')
    setOpen(false)
  }

  const txt = (key: 'address1' | 'address2' | 'city' | 'zip' | 'contact' | 'hours' | 'email' | 'refNo', clean: (s: string) => string = (s) => s) => ({
    ...ctl(d(key)),
    value: stop[key],
    disabled: base.disabled,
    onChange: (e: { target: { value: string } }) => onChange({ [key]: clean(e.target.value) } as Partial<FormStop>),
  })
  const delivery = stop.type === 'delivery'
  const readyDef = d('ready', required)
  const mustDef = d('mustDeliver')
  const dtField = (def: LabelDef, key: 'ready' | 'appt' | 'mustDeliver', req?: boolean) => (
    <LField def={def} required={req} error={err(def)}>
      <TmsInput {...ctl(def)} type="datetime-local" value={stop[key]} disabled={base.disabled} onChange={(e) => onChange({ [key]: e.target.value } as Partial<FormStop>)} />
    </LField>
  )

  return (
    <div className="ship-body" data-testid={`stop-${prefix}-fields`}>
      <LField def={nameDef} required={required} error={err(nameDef)}>
        <div className="ship-name-row">
          <div className="ship-typeahead">
            <TmsInput
              {...ctl(nameDef)} autoComplete="off" value={stop.name} disabled={placeLocked} title={stopLock}
              onChange={(e) => typeName(e.target.value)}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              onFocus={() => setOpen(query.length > 1)}
            />
            {open && matches.length > 0 && (
              <ul className="ship-typeahead-list" role="listbox" aria-label={`${nameDef.text} suggestions`}>
                {matches.map(({ record }) => (
                  <li key={record.id} role="option" aria-selected={record.id === stop.locationId}>
                    <button type="button" data-testid={`${nameDef.testId}-option`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(record)}>
                      {[record.name, [record.city, record.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <TmsIconButton aria-label={`Add location (${nameDef.text})`} data-testid={`f-${prefix}-addLocation`} disabled={placeLocked} onClick={() => setAdding(true)}>
            <Pencil size={13} />
          </TmsIconButton>
        </div>
      </LField>
      <LField def={d('address1')}><TmsInput {...txt('address1')} /></LField>
      <LField def={d('address2')}><TmsInput {...txt('address2')} /></LField>
      <LField def={d('city')} error={err(d('city'))}><TmsInput {...txt('city')} /></LField>
      <LField def={d('state')} error={err(d('state'))}>
        <TmsSelect {...ctl(d('state'))} value={stop.state} disabled={base.disabled} onChange={(e) => onChange({ state: e.target.value })}>
          <option value="" />
          {stop.state && !(US_STATES as readonly string[]).includes(stop.state) && <option value={stop.state}>{stop.state}</option>}
          {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </TmsSelect>
      </LField>
      <LField def={d('zip')} error={err(d('zip'))}><TmsInput {...txt('zip', (s) => digitsOnly(s).slice(0, 9))} inputMode="numeric" /></LField>
      <LField def={d('country')}>
        <TmsSelect {...ctl(d('country'))} value={stop.country || 'US'} disabled={base.disabled} onChange={(e) => onChange({ country: e.target.value })}>
          {COUNTRIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </TmsSelect>
      </LField>
      <LField def={d('contact')}><TmsInput {...txt('contact')} /></LField>
      <LField def={d('phone')}>
        <TmsInput {...ctl(d('phone'))} type="tel" placeholder="(XXX) XXX-XXXX" value={stop.phone} disabled={base.disabled} onChange={(e) => onChange({ phone: maskPhone(e.target.value) })} />
      </LField>
      <LField def={d('hours')}><TmsInput {...txt('hours')} /></LField>
      <LField def={d('email')} error={err(d('email'))}><TmsInput {...txt('email')} type="email" /></LField>
      <LField def={d('refNo')}><TmsInput {...txt('refNo')} /></LField>
      {delivery ? dtField(mustDef, 'mustDeliver') : dtField(readyDef, 'ready', required)}
      {dtField(d('appt'), 'appt')}
      {isBatory && (
        <span className="ship-hint" data-testid={`f-${prefix}-batory`}>
          <b>Batory load</b> — appointments are left blank on purpose; request them through the appointments page.
        </span>
      )}
      <LField def={d('note')}>
        <TmsTextarea {...ctl(d('note'))} rows={2} maxLength={MAX.stopNote} value={stop.note} disabled={base.disabled} onChange={(e) => onChange({ note: e.target.value })} />
      </LField>
      {adding && (
        <DirectoryCreateDialog
          type="location" open tmsTheme
          initial={{ name: stop.name, city: stop.city }}
          customers={ctx.directory.customers} divisions={[]}
          onClose={() => setAdding(false)}
          onSave={async (record, geocodeToken) => {
            const { id: _id, createdAt: _c, updatedAt: _u, ...input } = record as LocationRecord
            const loc = await createLocation({ ...input, ...(geocodeToken ? { geocodeToken } : {}) })
            onChange(stopPatchFromLocation(loc))
            toast.success('Location added')
          }}
        />
      )}
    </div>
  )
}

function StopImpl({ kind, index, stop, onChange, ctx }: StopSectionProps) {
  return <StopFields stop={stop} prefix={kind} required={kind === 'pickup'} onChange={onChange} ctx={ctx} key={index} />
}

export const StopSection = memo(StopImpl)
