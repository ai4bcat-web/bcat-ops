/**
 * One stop on the Route timeline (Step AR): dot + title, drag handle, delete; Location type-ahead
 * (recent first; picking fills address, hours and contact through `stopPatchFromLocation`),
 * address summary with an edit toggle, ready / must-deliver and appointment pickers, Ref #,
 * pieces / weight (what "Calculate totals from picks" counts) and the note. Same FormStop fields
 * and `f-<prefix>-<field>` test ids as the AH stop block (prefix: pickup | stop-<i> | consignee).
 */
import { useContext, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import { GripVertical, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { DirectoryCreateDialog } from '@/components/directory-picker/DirectoryCreateDialog'
import { TmsIconButton, TmsInput, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { createLocation } from '@/lib/apiClient'
import { requiresApptProofs } from '@/lib/apptQueue'
import { findLocationMatches } from '@/lib/tmsDirectory'
import type { LocationRecord } from '@/types/tms'
import { COUNTRIES, MAX, US_STATES } from '../constants'
import { LABEL, labelFor, type LabelDef } from '../labels'
import { FromEmailContext } from '../fromEmail'
import type { FormStop } from '../model'
import type { FormCtx } from '../sectionProps'
import { LField } from '../sections/formControls'
import { type StopKey, ctl, digitsOnly, disabledState, issueFor, maskPhone, stopDef, stopPatchFromLocation } from '../sections/fieldUtil'
import { pushRecent, readRecents, recentFirst } from './recents'
import { Typeahead, type TypeaheadItem } from './Typeahead'

export interface StopCardProps {
  stop: FormStop
  /** Position in the route (0-based) and the number of stops. */
  index: number
  count: number
  /** `pickup` | `stop-<i>` | `consignee` */
  prefix: string
  onChange: (patch: Partial<FormStop> | ((prev: FormStop) => FormStop)) => void
  ctx: FormCtx
  /** Null = this stop cannot be removed right now (reason in `removeBlocked`). */
  onRemove: (() => void) | null
  removeBlocked?: string
  /** Keyboard / drag reorder: move this stop by -1 / +1. */
  onMove: (by: -1 | 1) => void
  dragProps: {
    onDragStart: (e: DragEvent) => void
    onDragEnd: () => void
  }
}

const OFFERED = 8

const placeLine = (s: FormStop): string => {
  const cityState = [s.city.trim(), [s.state.trim(), s.zip.trim()].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return [s.address1.trim(), cityState].filter(Boolean).join(', ')
}

export function StopCard({ stop, index, count, prefix, onChange, ctx, onRemove, removeBlocked, onMove, dragProps }: StopCardProps) {
  const first = index === 0
  const delivery = stop.type === 'delivery'
  const userEmail = useAuthUser()?.email ?? ''
  const [recent, setRecent] = useState(() => readRecents('location', userEmail))
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const fromEmail = useContext(FromEmailContext)
  const [editAddr, setEditAddr] = useState(() => !stop.city.trim() || fromEmail.has(`f-${prefix}-city`))
  const base = disabledState(ctx)
  const stopLock = ctx.locked.stops[stop.id]
  const placeLocked = base.disabled || Boolean(stopLock)
  const section = prefix === 'pickup' ? 'pickup' : prefix === 'consignee' ? 'consignee' : 'picks'
  const d = (key: StopKey, req = false) => stopDef(prefix, key, req)
  const err = (def: LabelDef) => issueFor(ctx, section, def.testId)
  const isBatory = requiresApptProofs({ customer: ctx.customer?.name ?? '', customerApptWorkflow: ctx.customer?.apptWorkflow ?? null })
  const nameDef = d('name', first)
  const readyDef = d('ready', first)
  const addressIssue = [d('city'), d('state'), d('zip')].some((def) => err(def))

  const ensureLocations = ctx.directory.ensureLocations
  const searching = query.trim().length >= 2
  useEffect(() => { if (searching) ensureLocations?.() }, [searching, ensureLocations])

  const items = useMemo<TypeaheadItem[]>(() => {
    const sub = (r: LocationRecord) => [r.city, r.state].filter(Boolean).join(', ')
    const q = query.trim()
    if (q.length === 0) {
      return recentFirst(ctx.directory.locations, recent)
        .filter((r) => recent.includes(r.id))
        .map((r) => ({ id: r.id, label: r.name, sub: sub(r), recent: true }))
    }
    if (q.length < 2) return []
    const hits = findLocationMatches({ name: q, city: stop.city || undefined }, ctx.directory.locations).map((m) => m.record)
    return recentFirst(hits, recent).slice(0, OFFERED).map((r) => ({ id: r.id, label: r.name, sub: sub(r), recent: recent.includes(r.id) }))
  }, [query, stop.city, ctx.directory.locations, recent])

  const typeName = (text: string) => {
    setQuery(text)
    const linked = stop.locationId ? ctx.directory.locations.find((l) => l.id === stop.locationId) : null
    onChange(linked && linked.name !== text ? { name: text, locationId: '', geo: null } : { name: text })
  }
  const choose = (id: string) => {
    const loc = ctx.directory.locations.find((l) => l.id === id)
    if (!loc) return
    onChange(stopPatchFromLocation(loc))
    setRecent(pushRecent('location', userEmail, id))
    setQuery('')
    setEditAddr(false)
  }

  const txt = (key: 'address1' | 'address2' | 'city' | 'zip' | 'contact' | 'hours' | 'email' | 'refNo' | 'note', clean: (s: string) => string = (s) => s) => ({
    ...ctl(d(key)),
    value: stop[key],
    disabled: base.disabled,
    onChange: (e: { target: { value: string } }) => onChange({ [key]: clean(e.target.value) } as Partial<FormStop>),
  })
  const dtField = (def: LabelDef, key: 'ready' | 'appt' | 'mustDeliver', req?: boolean) => (
    <LField def={def} required={req} error={err(def)}>
      <TmsInput {...ctl(def)} type="datetime-local" value={stop[key]} disabled={base.disabled} onChange={(e) => onChange({ [key]: e.target.value } as Partial<FormStop>)} />
    </LField>
  )

  const numField = (key: 'pieces' | 'weightLbs', testPart: 'pieces' | 'weight') => (
    <LField def={LABEL.stop[key]}>
      <TmsInput
        inputMode="numeric" aria-label={`${LABEL.stop[key].text} (stop ${index + 1})`} data-testid={`f-picks-${testPart}-${index}`}
        value={stop[key]} disabled={base.disabled} onChange={(e) => onChange({ [key]: digitsOnly(e.target.value) } as Partial<FormStop>)}
      />
    </LField>
  )

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1) }
    if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1) }
  }

  const title = delivery ? (index === count - 1 ? 'Delivery' : `Delivery ${index + 1}`) : first ? 'Pickup' : `Pickup ${index + 1}`
  const line = placeLine(stop)

  return (
    <div className="tms-card-stop" data-testid={`stop-${prefix}-fields`} data-type={stop.type}>
      <div className="tms-card-stop-head">
        <span className="tms-card-stop-dot" data-type={stop.type} aria-hidden="true" />
        <strong className="tms-card-stop-title">{title}</strong>
        <span className="tms-card-spacer" />
        <button
          type="button" className="tms-card-handle" draggable={!base.disabled}
          aria-label={`Reorder stop ${index + 1} (drag, or press arrow up / down)`} data-testid={`f-route-handle-${index}`}
          disabled={base.disabled} onKeyDown={handleKey} {...dragProps}
        >
          <GripVertical size={14} />
        </button>
        <TmsIconButton
          aria-label={`Remove stop ${index + 1}`} data-testid={`f-route-remove-${index}`}
          title={onRemove ? undefined : removeBlocked} disabled={base.disabled || !onRemove} onClick={() => onRemove?.()}
        >
          <Trash2 size={13} />
        </TmsIconButton>
      </div>

      <LField def={nameDef} required={first} error={err(nameDef)}>
        <div className="ship-name-row">
          <Typeahead
            inputTestId={nameDef.testId} optionTestId={`${nameDef.testId}-option`} ariaLabel={labelFor(nameDef)}
            placeholder="Search locations…" value={stop.name} onValueChange={typeName} items={items} onPick={choose}
            disabled={placeLocked} title={stopLock} onFocus={() => ensureLocations?.()}
          />
          <TmsIconButton aria-label={`Add location (${nameDef.text})`} data-testid={`f-${prefix}-addLocation`} disabled={placeLocked} onClick={() => setAdding(true)}>
            <Pencil size={13} />
          </TmsIconButton>
        </div>
      </LField>

      {!editAddr && !addressIssue ? (
        <div className="tms-card-addr-line">
          <span data-testid={`f-${prefix}-addressLine`}>{line || 'No address yet'}</span>
          <button type="button" className="ship-link" data-testid={`f-${prefix}-editAddress`} disabled={base.disabled} onClick={() => setEditAddr(true)}>Edit address</button>
        </div>
      ) : (
        <div className="tms-card-grid tms-card-grid-addr">
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
        </div>
      )}

      <div className="tms-card-grid">
        {delivery ? dtField(d('mustDeliver'), 'mustDeliver') : dtField(readyDef, 'ready', first)}
        {dtField(d('appt'), 'appt')}
        <LField def={d('refNo')}><TmsInput {...txt('refNo')} /></LField>
        <LField def={d('hours')}><TmsInput {...txt('hours')} /></LField>
      </div>
      {isBatory && (
        <span className="ship-hint" data-testid={`f-${prefix}-batory`}>
          <b>Batory load</b> — appointments are left blank on purpose; request them through the appointments page.
        </span>
      )}
      <div className="tms-card-grid">
        <LField def={d('contact')}><TmsInput {...txt('contact')} /></LField>
        <LField def={d('phone')}>
          <TmsInput {...ctl(d('phone'))} type="tel" placeholder="(XXX) XXX-XXXX" value={stop.phone} disabled={base.disabled} onChange={(e) => onChange({ phone: maskPhone(e.target.value) })} />
        </LField>
        <LField def={d('email')} error={err(d('email'))}><TmsInput {...txt('email')} type="email" /></LField>
        {numField('pieces', 'pieces')}
        {numField('weightLbs', 'weight')}
      </div>
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
            setRecent(pushRecent('location', userEmail, loc.id))
            toast.success('Location added')
          }}
        />
      )}
    </div>
  )
}
