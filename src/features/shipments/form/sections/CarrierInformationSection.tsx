/**
 * Carrier Information (AH-plan §4.9). Inputs work in create mode (they live in the form and
 * the local draft). Picking an own-fleet driver queues ASSIGN_ASSET after creation; saved
 * shipments use the existing BookCarrierDialog (own fleet: AssignDriverDialog) via
 * ctx.actions.cover(). Step AR card 5: collapsed to "No carrier yet" + Cover/Assign
 * until a carrier is picked (or Ivan Cartage / a typed name is chosen).
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsButton, TmsInput, TmsSelect } from '@/features/tms/kit'
import { OwnFleetDriverPicker } from '@/components/OwnFleetDriverPicker'
import { useOwnFleetRoster } from '@/hooks/useOwnFleetRoster'
import { useDrivers } from '@/hooks/useDrivers'
import { listOwnershipDivisions, listOwnershipRules } from '@/lib/apiClient'
import { resolveDivision, shipmentContextFor } from '@/lib/ownership'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { isIvanCartageName, ownFleetDriverByName, ownFleetFill } from '@/lib/ownFleetDrivers'
import { mcpPacketStanding } from '@/lib/mcpPacket'
import { isTruckloadMode } from '@/lib/shipmentStatus'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/tmsDirectory'
import type { CarrierRecord, InsurancePolicyType, LoadCarrierRecord, OwnershipDivisionRecord, OwnershipRuleRecord } from '@/types/tms'
import { US_STATES } from '../constants'
import { LABEL } from '../labels'
import { activeLoadCarrier, isCustomerDefaultDivision, isLocked, liveCarriers, lockReason } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { ColGroup, ColGroups, Field, FieldGrid } from '../fieldGrid'
import { validateCarrierAdd } from '@/lib/carrierLegs'
import { fieldAttrs } from './fieldAttrs'
import { FindInvite } from './carrier/FindInvite'
import '../cards/moneyCards.css'


function policyText(carrier: CarrierRecord | null, type: InsurancePolicyType): string {
  const p = carrier?.insurancePolicies?.find((x) => x.type === type)
  if (!p) return '—'
  const limit = p.limitCents != null ? `$${formatCents(p.limitCents)}` : '—'
  const expired = p.expiresAt ? new Date(p.expiresAt) < new Date() : false
  return `${limit}${p.expiresAt ? ` · exp ${p.expiresAt}` : ''}${expired ? ' (expired)' : ''}`
}

function Static({ def, text, span = 4, narrow = 6, tag = '' }: { def: { text: string; testId: string }; text: string; span?: number; narrow?: number; tag?: string }) {
  return (
    <Field span={span} narrow={narrow} label={def.text}>
      <TmsInput aria-label={tag ? `${def.text} ${tag}` : def.text} data-testid={tag ? `${def.testId}-${tag}` : def.testId} readOnly value={text} />
    </Field>
  )
}

/** Which carrier of the load a section instance is: slot 0 keeps every legacy id; the others suffix theirs with the slot key. */
export interface CarrierSlotProps {
  /** The slot key (`c1`…). Absent = the first carrier. */
  slotKey?: string
  /** Position in the carrier list; 0 = first. */
  index?: number
  /** The booked assignment this block shows; absent = the primary (first block only). */
  loadCarrier?: LoadCarrierRecord | null
  /** `Stop.id`s this carrier covers (validateCarrierAdd's disjoint-legs rule). */
  legStopIds?: string[]
}

function CarrierInformationSectionImpl({ value, onChange, ctx, form, expanded = false, slotKey = 'c0', index = 0, loadCarrier, legStopIds = [] }: SliceSectionProps<'carrier'> & CarrierSlotProps & { expanded?: boolean }) {
  const roster = useOwnFleetRoster()
  const [search, setSearch] = useState('')
  const [assigning, setAssigning] = useState(false)
  // Slot 0 keeps every legacy id and label; another carrier's controls carry its slot key.
  const extra = index > 0
  const tag = extra ? slotKey : ''
  const x = (id: string) => (tag ? `${id}-${tag}` : id)
  const fa = (def: Parameters<typeof fieldAttrs>[0]) => {
    const a = fieldAttrs(def)
    return tag ? { 'aria-label': `${a['aria-label']} ${tag}`, 'data-testid': x(a['data-testid']) } : a
  }

  const bundle = ctx.bundle
  const active = loadCarrier !== undefined ? loadCarrier : activeLoadCarrier(bundle)
  const saved = ctx.mode === 'edit' && bundle != null
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  const pickerLocked = isLocked(ctx.locked, 'carrierPicker') || active != null
  const carrier = ctx.directory.carriers.find((c) => c.id === value.carrierId) ?? null
  const own = value.isOwnFleet
  // Step AQ: a directory carrier that is Ivan Cartage is own fleet too: its driver is picked from our
  // Driver records in "Enter driver info", never typed here.
  const typedLock = own || isIvanCartageName(carrier?.name ?? active?.carrierName)
  const { drivers } = useDrivers()
  const [ownership, setOwnership] = useState<{ divisions: OwnershipDivisionRecord[]; rules: OwnershipRuleRecord[] } | null>(null)
  useEffect(() => {
    if (!own || saved) return
    let live = true
    Promise.all([listOwnershipDivisions(), listOwnershipRules()]).then(([divisions, rules]) => {
      if (live) setOwnership({ divisions, rules })
    }).catch(() => { /* An unavailable preview must not block assignment. */ })
    return () => { live = false }
  }, [own, saved])
  const pickedDriver = ownFleetDriverByName(roster, value.driver1.name)
  const draft = form.getValues()
  const driver = drivers.find((d) => d.id === pickedDriver?.id)
  const predicted = !saved && own && driver && ownership && isCustomerDefaultDivision(draft, ctx.customer)
    ? resolveDivision(ownership.divisions, ownership.rules, shipmentContextFor({
      driver, loadCarrier: { kind: 'OWN_ASSET' },
      shipment: { customerId: draft.customer.id },
    })) : null
  const divisionHint = predicted && ownership
    ? [predicted.revDivision, predicted.revSubdivision].filter(Boolean).map((code) => ownership.divisions.find((d) => d.code === code)?.name ?? code).join(' > ')
    : ''
  const set = (patch: Partial<typeof value>) => onChange(patch)
  const setBits = (key: 'dispatcher' | 'driver1' | 'driver2', patch: Partial<typeof value.dispatcher>) =>
    onChange((p) => ({ ...p, [key]: { ...p[key], ...patch } }))

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return ctx.directory.carriers
      .filter((c) => [c.name, c.dbaName, c.mcNumber, c.dotNumber, c.scac].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 8)
  }, [ctx.directory.carriers, search])


  const standing = carrier ? effectiveCarrierStatus(carrier, new Date()) : null
  const packet = carrier ? mcpPacketStanding(carrier) : null
  const unvetted = carrier != null && (standing?.status !== 'ACTIVE' || !packet?.completed)

  const pick = (c: CarrierRecord) => {
    set({
      carrierId: c.id, typedName: '', useTyped: false, isOwnFleet: false,
      dispatcher: {
        name: value.dispatcher.name || c.dispatcherName || '',
        phone: value.dispatcher.phone || c.dispatcherPhone || '',
        email: value.dispatcher.email || c.dispatcherEmail || '',
      },
    })
    setSearch('')
  }
  const clear = () => set({ carrierId: '', typedName: '', useTyped: false, isOwnFleet: false })

  const loadStatus = bundle?.loads[0]?.status
  const addBlock = (): string | null => {
    if (value.isOwnFleet) return validateCarrierAdd([], { kind: 'OWN_ASSET' })
    if (!value.carrierId) return 'Pick the carrier from the directory first'
    return validateCarrierAdd(
      liveCarriers(bundle).map((lc) => ({ id: lc.id, kind: lc.kind, carrierId: lc.carrierId, legStopIds: lc.legStopIds })),
      { kind: 'CARRIER', carrierId: value.carrierId, legStopIds },
    )
  }
  const coverBlock = !saved
    ? own && value.driver1.name.trim() ? 'Driver will be assigned when you create or save the shipment' : 'Save the draft first'
    : isLocked(ctx.locked, 'cover') ? lockReason(ctx.locked, 'cover') ?? 'Cover is locked'
    : extra
      ? active ? 'This carrier is already added'
        : loadStatus !== 'SOURCING' && loadStatus !== 'BOOKED' && loadStatus !== 'DISPATCHED' ? 'The load must be open to add a carrier'
        : !isTruckloadMode(bundle?.shipment.mode) ? 'Only truckload modes can be covered'
        : addBlock()
      : active ? 'A carrier is already covering this load'
      : loadStatus !== 'SOURCING' ? 'The load must be SOURCING to cover'
      : !isTruckloadMode(bundle?.shipment.mode) ? 'Only truckload modes can be covered'
      : null
  // Why this block cannot be own fleet: Ivan Cartage never shares a load with outside carriers.
  const ownFleetBlock = extra ? validateCarrierAdd([], { kind: 'OWN_ASSET' }) : null

  // Own fleet opens the driver dialog; every other carrier goes through the Step AM ladder (directory first, then MCP).
  const onCover = () => (extra ? ctx.actions.cover(slotKey) : ctx.actions.cover())
  // The first block drives the primary assignment's own actions; the others name theirs.
  const open = (kind: 'dispatch' | 'rateCon' | 'info') => {
    if (extra && active) ctx.actions.openFor(kind, active.id)
    else if (kind === 'dispatch') ctx.actions.openDispatch()
    else if (kind === 'rateCon') ctx.actions.openSendRateCon()
    else ctx.actions.openSendInfo()
  }

  const dash = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : '—')
  const needSave = saved ? undefined : 'Save the draft first'

  const hasCarrier = carrier != null || own || value.useTyped || active != null
  if (!hasCarrier && !assigning && !expanded && !extra) {
    return (
      <div className="tms-card-carrier-empty" data-testid={x('section-carrier-body')}>
        <span className="tms-card-carrier-empty-text" data-testid={x('carrier-empty')}>No carrier yet</span>
        <TmsButton
          variant="primary"
          size="sm"
          data-testid={x(LABEL.carrier.cover.testId)}
          title={coverBlock ?? undefined}
          disabled={disabled || coverBlock != null}
          onClick={onCover}
        >
          {LABEL.carrier.cover.text}
        </TmsButton>
        <TmsButton size="sm" data-testid={x('carrier-assign')} disabled={disabled || pickerLocked} onClick={() => setAssigning(true)}>
          Assign…
        </TmsButton>
        {coverBlock && <span className="tms-muted text-xs" data-testid={x('carrier-cover-reason')}>{coverBlock}</span>}
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid={x('section-carrier-body')}>
      {saved && !active && value.carrierId && (
        <p className="tms-muted text-xs" data-testid={x('carrier-not-covered')}>Carrier selected — not covered yet</p>
      )}

      <div className="tms-card-carrier-grid">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            {carrier ? (
              <Link to={`/tms/carriers/${carrier.id}`} className="tms-field-label underline" data-testid={x('carrier-link')}>{LABEL.carrier.carrier.text}</Link>
            ) : (
              <label className="tms-field-label" htmlFor={x('carrier-search')}>{LABEL.carrier.carrier.text}</label>
            )}
            {carrier && <span>{carrier.name}</span>}
            {own && <strong>Ivan Cartage (own fleet)</strong>}
            {value.useTyped && <span>{value.typedName}</span>}
            {(carrier || own || value.useTyped) && !pickerLocked && (
              <TmsButton size="sm" variant="ghost" aria-label={tag ? `Clear carrier ${tag}` : 'Clear carrier'} disabled={disabled} onClick={clear}>✕</TmsButton>
            )}
          </div>
          {!carrier && !own && !value.useTyped && (
            <>
              <TmsInput
                id={x('carrier-search')}
                {...fa(LABEL.carrier.carrier)}
                value={search}
                placeholder="Name, MC, DOT or SCAC"
                disabled={disabled || pickerLocked}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ul className="space-y-1" data-testid={x('carrier-matches')}>
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="w-full rounded border px-2 py-1 text-left text-sm"
                      style={{ borderColor: 'var(--tms-border)', background: 'none', color: 'inherit' }}
                      onClick={() => pick(c)}
                    >
                      {c.name}{c.mcNumber ? ` · MC ${c.mcNumber}` : ''}{c.dotNumber ? ` · DOT ${c.dotNumber}` : ''}
                    </button>
                  </li>
                ))}
              </ul>
              {isIvanCartageName(search) && (
                <p className="text-xs" data-testid={x('carrier-ivan-hint')}>
                  Ivan Cartage is our own fleet — use the roster picker below.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <TmsButton
                  size="sm"
                  data-testid={x('carrier-own-fleet')}
                  disabled={disabled || pickerLocked || ownFleetBlock != null}
                  title={ownFleetBlock ?? undefined}
                  onClick={() => set({ carrierId: '', typedName: '', useTyped: false, isOwnFleet: true })}
                >
                  Ivan Cartage (own fleet)
                </TmsButton>
                {extra ? (
                  <span className="tms-muted text-xs" data-testid={x('carrier-own-fleet-reason')}>{ownFleetBlock}</span>
                ) : (
                  <TmsButton
                    size="sm"
                    variant="ghost"
                    data-testid={x('carrier-record-name')}
                    disabled={disabled || pickerLocked}
                    onClick={() => {
                      if (isIvanCartageName(search)) { set({ carrierId: '', typedName: '', useTyped: false, isOwnFleet: true }); setSearch(''); return }
                      set({ carrierId: '', useTyped: true, typedName: search.trim(), isOwnFleet: false })
                      setSearch('')
                    }}
                  >
                    Not in the directory — record the name
                  </TmsButton>
                )}
              </div>
            </>
          )}
          {value.useTyped && (
            <TmsInput
              aria-label={tag ? `Carrier name ${tag}` : 'Carrier name'}
              value={value.typedName}
              disabled={disabled || pickerLocked}
              onChange={(e) => {
                const text = e.target.value
                if (isIvanCartageName(text)) set({ typedName: '', useTyped: false, isOwnFleet: true })
                else set({ typedName: text })
              }}
            />
          )}
          {carrier && standing && (
            <div className="flex flex-wrap items-center gap-2 text-xs" data-testid={x('carrier-standing')}>
              <TmsBadge tone="gray">{CARRIER_STATUS_LABELS[standing.status]}</TmsBadge>
              {packet && !packet.completed && <span className="tms-muted">{packet.reason}</span>}
            </div>
          )}
          {unvetted && carrier && (
            <FindInvite
              key={carrier.id}
              carrierId={carrier.id}
              defaultEmail={carrier.email ?? ''}
              disabled={disabled || !saved}
              send={ctx.actions.sendSetupPacket}
            />
          )}
        </div>

        <FieldGrid>
          <Static tag={tag} def={LABEL.carrier.mc} narrow={12} text={carrier?.mcNumber ?? '—'} />
          <Static tag={tag} def={LABEL.carrier.dot} text={carrier?.dotNumber ?? '—'} />
          <Static tag={tag} def={LABEL.carrier.scac} text={carrier?.scac ?? '—'} />
          <Static tag={tag} def={LABEL.carrier.safetyRating} text={carrier?.safetyRating ?? '—'} />
          <Static tag={tag} def={LABEL.carrier.cargo} text={policyText(carrier, 'CARGO')} />
          <Static tag={tag} def={LABEL.carrier.liability} text={policyText(carrier, 'AUTO_LIABILITY')} />
          <Static tag={tag} def={LABEL.carrier.genLiability} text={policyText(carrier, 'GENERAL_LIABILITY')} />
          <Static tag={tag} def={LABEL.carrier.email} text={carrier?.email ?? '—'} />
          <Static tag={tag} def={LABEL.carrier.phone} text={carrier?.phone ?? '—'} />
        </FieldGrid>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TmsButton
          variant="primary"
          size="sm"
          data-testid={x(LABEL.carrier.cover.testId)}
          title={coverBlock ?? undefined}
          disabled={disabled || coverBlock != null}
          onClick={onCover}
        >
          {LABEL.carrier.cover.text}
        </TmsButton>
        {coverBlock && <span className="tms-muted text-xs" data-testid={x('carrier-cover-reason')}>{coverBlock}</span>}
      </div>

      <ColGroups testId={x('carrier-cols')}>
        <ColGroup title="Dispatch & drivers">
          <FieldGrid>
        <Field span={12} label={LABEL.carrier.dispatcher.text}>
          <TmsInput {...fa(LABEL.carrier.dispatcher)} value={value.dispatcher.name} disabled={disabled || own}
            onChange={(e) => setBits('dispatcher', { name: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.dispatcherPhone.text}>
          <TmsInput {...fa(LABEL.carrier.dispatcherPhone)} type="tel" value={value.dispatcher.phone} disabled={disabled || own}
            onChange={(e) => setBits('dispatcher', { phone: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.dispatcherEmail.text}>
          <TmsInput {...fa(LABEL.carrier.dispatcherEmail)} type="email" value={value.dispatcher.email} disabled={disabled || own}
            onChange={(e) => setBits('dispatcher', { email: e.target.value })} />
        </Field>

        {own ? (
          <Field span={12} label={LABEL.carrier.driver1.text} info="One driver per Ivan Cartage load">
            <OwnFleetDriverPicker
              roster={roster}
              value={ownFleetDriverByName(roster, value.driver1.name)?.id ?? ''}
              ariaLabel={LABEL.carrier.driver1.text}
              testId={x(LABEL.carrier.driver1.testId)}
              disabled={disabled}
              showSummary={false}
              onChange={(d) => onChange((p) => {
                const fill = d ? ownFleetFill(d) : null
                return {
                  ...p,
                  driver1: { name: fill?.driverName ?? '', phone: fill?.driverPhone ?? '', email: d?.email ?? '' },
                  truckNo: fill?.truckNumber ?? '',
                  trailerNo: fill?.trailerNumber ?? '',
                }
              })}
            />
            {!saved && divisionHint && <p className="tms-muted text-xs">Will count as {divisionHint}</p>}
            {!saved && !isCustomerDefaultDivision(draft, ctx.customer) && <p className="tms-muted text-xs">The selected revenue division is retained; assigning a driver does not override a manual tag.</p>}
          </Field>
        ) : (
          <Field span={12} label={LABEL.carrier.driver1.text}>
            <TmsInput {...fa(LABEL.carrier.driver1)} value={value.driver1.name} disabled={disabled} readOnly={typedLock}
              onChange={(e) => setBits('driver1', { name: e.target.value })} />
          </Field>
        )}
        <Field span={6} label={LABEL.carrier.driver1Cell.text}>
          <TmsInput {...fa(LABEL.carrier.driver1Cell)} type="tel" value={value.driver1.phone} disabled={disabled} readOnly={typedLock}
            onChange={(e) => setBits('driver1', { phone: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.driver1Email.text}>
          <TmsInput {...fa(LABEL.carrier.driver1Email)} type="email" value={value.driver1.email} disabled={disabled} readOnly={own}
            onChange={(e) => setBits('driver1', { email: e.target.value })} />
        </Field>

        {!own && (
          <>
            <Field span={12} label={LABEL.carrier.driver2.text}>
              <TmsInput {...fa(LABEL.carrier.driver2)} value={value.driver2.name} disabled={disabled} readOnly={typedLock}
                onChange={(e) => setBits('driver2', { name: e.target.value })} />
            </Field>
            <Field span={6} label={LABEL.carrier.driver2Cell.text}>
              <TmsInput {...fa(LABEL.carrier.driver2Cell)} type="tel" value={value.driver2.phone} disabled={disabled} readOnly={typedLock}
                onChange={(e) => setBits('driver2', { phone: e.target.value })} />
            </Field>
            <Field span={6} label={LABEL.carrier.driver2Email.text}>
              <TmsInput {...fa(LABEL.carrier.driver2Email)} type="email" value={value.driver2.email} disabled={disabled}
                onChange={(e) => setBits('driver2', { email: e.target.value })} />
            </Field>
          </>
        )}

          </FieldGrid>
        </ColGroup>
        <ColGroup title="Equipment & trip">
          <FieldGrid>
        <Field span={6} label={LABEL.carrier.truckNo.text}>
          <TmsInput {...fa(LABEL.carrier.truckNo)} maxLength={40} value={value.truckNo} disabled={disabled} readOnly={typedLock}
            onChange={(e) => set({ truckNo: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.trailerNo.text}>
          <TmsInput {...fa(LABEL.carrier.trailerNo)} maxLength={40} value={value.trailerNo} disabled={disabled} readOnly={typedLock}
            onChange={(e) => set({ trailerNo: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.seal.text}>
          <TmsInput {...fa(LABEL.carrier.seal)} maxLength={40} value={value.seal} disabled={disabled}
            onChange={(e) => set({ seal: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.carrierRef.text}>
          <TmsInput {...fa(LABEL.carrier.carrierRef)} maxLength={40} value={value.carrierRef} disabled={disabled}
            onChange={(e) => set({ carrierRef: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.originCity.text}>
          <TmsInput {...fa(LABEL.carrier.originCity)} value={value.originCity} disabled={disabled}
            onChange={(e) => set({ originCity: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.originState.text}>
          <TmsSelect
            {...fa(LABEL.carrier.originState)}
            value={value.originState}
            disabled={disabled}
            placeholder=""
            onChange={(e) => set({ originState: e.target.value })}
            options={US_STATES.map((s) => ({ value: s, label: s }))}
          />
        </Field>
        <Field span={6} label={LABEL.carrier.emptyMiles.text}>
          <TmsInput {...fa(LABEL.carrier.emptyMiles)} type="number" min={0} value={value.emptyMiles} disabled={disabled}
            onChange={(e) => set({ emptyMiles: e.target.value })} />
        </Field>
        <Field span={6} label={LABEL.carrier.puEta.text}>
          <TmsInput {...fa(LABEL.carrier.puEta)} type="datetime-local" value={value.puEta} disabled={disabled}
            onChange={(e) => set({ puEta: e.target.value })} />
        </Field>
          </FieldGrid>
        </ColGroup>
      </ColGroups>

      <FieldGrid>
        <Static tag={tag} def={LABEL.carrier.confirmSent} narrow={12} text={dash(active?.rateConSentAt)} />
        <Static tag={tag} def={LABEL.carrier.confirmRec} text={dash(active?.rateConSignedAt)} />
        <Static tag={tag} def={LABEL.carrier.dispatched} text={dash(active?.dispatchedAt)} />
      </FieldGrid>

      <div className="tms-fg-toolbar tms-lock-exempt">
        <TmsButton size="sm" data-testid={x('carrier-dispatch')} disabled={disabled || !active} title={active ? undefined : 'Cover a carrier first'} onClick={() => open('dispatch')}>
          Dispatch
        </TmsButton>
        <TmsButton size="sm" data-testid={x(LABEL.carrier.sendRateConf.testId)} disabled={disabled || !active} title={active ? needSave : 'Cover a carrier first'} onClick={() => open('rateCon')}>
          {LABEL.carrier.sendRateConf.text}
        </TmsButton>
        <TmsButton size="sm" data-testid={x(LABEL.carrier.sendInfo.testId)} disabled={disabled || !active} title={active ? needSave : 'Cover a carrier first'} onClick={() => open('info')}>
          {LABEL.carrier.sendInfo.text}
        </TmsButton>
      </div>
    </div>
  )
}

export const CarrierInformationSection = memo(CarrierInformationSectionImpl)
