/**
 * Carrier Information (AH-plan §4.9). Inputs work in create mode (they live in the form and
 * the local draft); every button that talks to the server needs a saved shipment. Cover goes
 * through the existing BookCarrierDialog (own fleet: AssignDriverDialog) — this section only
 * opens it with the form's values prefilled via `ctx.actions.cover()`.
 */
import { memo, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TmsBadge, TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { useDrivers } from '@/hooks/useDrivers'
import { CARRIER_STATUS_LABELS, effectiveCarrierStatus } from '@/lib/carrierStatus'
import { selectableDrivers } from '@/lib/driverFilter'
import { mcpPacketStanding } from '@/lib/mcpPacket'
import { isBrokerDriver } from '@/lib/ownAssetDriver'
import { isTruckloadMode } from '@/lib/shipmentStatus'
import { formatDateTime } from '@/lib/date'
import { formatCents } from '@/lib/tmsDirectory'
import type { CarrierRecord, InsurancePolicyType } from '@/types/tms'
import { US_STATES } from '../constants'
import { LABEL } from '../labels'
import { financialPreview } from '../mapping'
import { activeLoadCarrier, isLocked, lockReason } from '../model'
import type { SliceSectionProps } from '../sectionRegistry'
import { fieldAttrs } from './fieldAttrs'
import { FindInvite } from './carrier/FindInvite'

const IVAN_RE = /^\s*ivan\s+cartage\b/i

function policyText(carrier: CarrierRecord | null, type: InsurancePolicyType): string {
  const p = carrier?.insurancePolicies?.find((x) => x.type === type)
  if (!p) return '—'
  const limit = p.limitCents != null ? `$${formatCents(p.limitCents)}` : '—'
  const expired = p.expiresAt ? new Date(p.expiresAt) < new Date() : false
  return `${limit}${p.expiresAt ? ` · exp ${p.expiresAt}` : ''}${expired ? ' (expired)' : ''}`
}

function Static({ def, text }: { def: { text: string; testId: string }; text: string }) {
  return (
    <TmsField label={def.text}>
      <TmsInput aria-label={def.text} data-testid={def.testId} readOnly value={text} />
    </TmsField>
  )
}

function CarrierInformationSectionImpl({ value, onChange, ctx, form }: SliceSectionProps<'carrier'>) {
  const { drivers } = useDrivers()
  const [search, setSearch] = useState('')
  const [coverHint, setCoverHint] = useState<string | null>(null)

  const bundle = ctx.bundle
  const active = activeLoadCarrier(bundle)
  const saved = ctx.mode === 'edit' && bundle != null
  const disabled = ctx.busy || isLocked(ctx.locked, 'all')
  const pickerLocked = isLocked(ctx.locked, 'carrierPicker') || active != null
  const carrier = ctx.directory.carriers.find((c) => c.id === value.carrierId) ?? null
  const own = value.isOwnFleet
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

  const roster = useMemo(() => selectableDrivers(drivers).filter((d) => !isBrokerDriver(d)), [drivers])

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
  const coverBlock = !saved
    ? 'Save the draft first'
    : isLocked(ctx.locked, 'cover') ? lockReason(ctx.locked, 'cover') ?? 'Cover is locked'
    : active ? 'A carrier is already covering this load'
    : loadStatus !== 'SOURCING' ? 'The load must be SOURCING to cover'
    : !isTruckloadMode(bundle?.shipment.mode) ? 'Only truckload modes can be covered'
    : !own && !value.carrierId ? 'Pick a carrier from the directory'
    : !own && (!value.originCity.trim() || !value.originState.trim()) ? 'Origin City and Origin State are required'
    : null

  const onCover = () => {
    // The carrier rate lives in Rates (another slice); it is read here, at click time.
    if (!own && financialPreview(form.getValues(), ctx.customer, ctx.settings).carrierTotalLhCents <= 0) {
      setCoverHint('Enter a carrier rate in Rates first')
      return
    }
    setCoverHint(null)
    ctx.actions.cover()
  }

  const dash = (iso: string | null | undefined) => (iso ? formatDateTime(iso) : '—')
  const needSave = saved ? undefined : 'Save the draft first'

  return (
    <div className="space-y-3" data-testid="section-carrier-body">
      {saved && !active && value.carrierId && (
        <p className="tms-muted text-xs" data-testid="carrier-not-covered">Carrier selected — not covered yet</p>
      )}

      <div className="grid gap-2 min-[1500px]:grid-cols-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            {carrier ? (
              <Link to={`/tms/carriers/${carrier.id}`} className="tms-field-label underline" data-testid="carrier-link">{LABEL.carrier.carrier.text}</Link>
            ) : (
              <label className="tms-field-label" htmlFor="carrier-search">{LABEL.carrier.carrier.text}</label>
            )}
            {carrier && <span>{carrier.name}</span>}
            {own && <strong>Ivan Cartage (own fleet)</strong>}
            {value.useTyped && <span>{value.typedName}</span>}
            {(carrier || own || value.useTyped) && !pickerLocked && (
              <TmsButton size="sm" variant="ghost" aria-label="Clear carrier" disabled={disabled} onClick={clear}>✕</TmsButton>
            )}
          </div>
          {!carrier && !own && !value.useTyped && (
            <>
              <TmsInput
                id="carrier-search"
                {...fieldAttrs(LABEL.carrier.carrier)}
                value={search}
                placeholder="Name, MC, DOT or SCAC"
                disabled={disabled || pickerLocked}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ul className="space-y-1" data-testid="carrier-matches">
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
              {IVAN_RE.test(search) && (
                <p className="text-xs" data-testid="carrier-ivan-hint">
                  Ivan Cartage is our own fleet — use the roster picker below.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <TmsButton
                  size="sm"
                  data-testid="carrier-own-fleet"
                  disabled={disabled || pickerLocked}
                  onClick={() => set({ carrierId: '', typedName: '', useTyped: false, isOwnFleet: true })}
                >
                  Ivan Cartage (own fleet)
                </TmsButton>
                <TmsButton
                  size="sm"
                  variant="ghost"
                  data-testid="carrier-record-name"
                  disabled={disabled || pickerLocked}
                  onClick={() => {
                    if (IVAN_RE.test(search)) { set({ carrierId: '', typedName: '', useTyped: false, isOwnFleet: true }); setSearch(''); return }
                    set({ carrierId: '', useTyped: true, typedName: search.trim(), isOwnFleet: false })
                    setSearch('')
                  }}
                >
                  Not in the directory — record the name
                </TmsButton>
              </div>
            </>
          )}
          {value.useTyped && (
            <TmsInput
              aria-label="Carrier name"
              value={value.typedName}
              disabled={disabled || pickerLocked}
              onChange={(e) => {
                const text = e.target.value
                if (IVAN_RE.test(text)) set({ typedName: '', useTyped: false, isOwnFleet: true })
                else set({ typedName: text })
              }}
            />
          )}
          {carrier && standing && (
            <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="carrier-standing">
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

        <div className="grid grid-cols-2 gap-2 min-[1500px]:col-span-2 min-[1500px]:grid-cols-4">
          <Static def={LABEL.carrier.mc} text={carrier?.mcNumber ?? '—'} />
          <Static def={LABEL.carrier.dot} text={carrier?.dotNumber ?? '—'} />
          <Static def={LABEL.carrier.scac} text={carrier?.scac ?? '—'} />
          <Static def={LABEL.carrier.safetyRating} text={carrier?.safetyRating ?? '—'} />
          <Static def={LABEL.carrier.cargo} text={policyText(carrier, 'CARGO')} />
          <Static def={LABEL.carrier.liability} text={policyText(carrier, 'AUTO_LIABILITY')} />
          <Static def={LABEL.carrier.genLiability} text={policyText(carrier, 'GENERAL_LIABILITY')} />
          <Static def={LABEL.carrier.email} text={carrier?.email ?? '—'} />
          <Static def={LABEL.carrier.phone} text={carrier?.phone ?? '—'} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TmsButton
          variant="primary"
          size="sm"
          data-testid={LABEL.carrier.cover.testId}
          title={coverBlock ?? undefined}
          disabled={disabled || coverBlock != null}
          onClick={onCover}
        >
          {LABEL.carrier.cover.text}
        </TmsButton>
        {coverBlock && <span className="tms-muted text-xs" data-testid="carrier-cover-reason">{coverBlock}</span>}
        {coverHint && <span className="text-xs" role="alert" data-testid="carrier-cover-hint">{coverHint}</span>}
      </div>

      <div className="grid grid-cols-2 gap-2 min-[1500px]:grid-cols-3">
        <TmsField label={LABEL.carrier.dispatcher.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.dispatcher)} value={value.dispatcher.name} disabled={disabled || own}
            onChange={(e) => setBits('dispatcher', { name: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.dispatcherPhone.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.dispatcherPhone)} type="tel" value={value.dispatcher.phone} disabled={disabled || own}
            onChange={(e) => setBits('dispatcher', { phone: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.dispatcherEmail.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.dispatcherEmail)} type="email" value={value.dispatcher.email} disabled={disabled || own}
            onChange={(e) => setBits('dispatcher', { email: e.target.value })} />
        </TmsField>

        {own ? (
          <TmsField label={LABEL.carrier.driver1.text} hint="One driver per Ivan Cartage load">
            <TmsSelect
              {...fieldAttrs(LABEL.carrier.driver1)}
              value={roster.find((d) => d.name === value.driver1.name)?.id ?? ''}
              disabled={disabled}
              placeholder="Pick a driver"
              onChange={(e) => {
                const d = roster.find((x) => x.id === e.target.value)
                setBits('driver1', { name: d?.name ?? '', phone: d?.phone ?? '', email: d?.email ?? '' })
              }}
              options={roster.map((d) => ({ value: d.id, label: d.name }))}
            />
          </TmsField>
        ) : (
          <TmsField label={LABEL.carrier.driver1.text}>
            <TmsInput {...fieldAttrs(LABEL.carrier.driver1)} value={value.driver1.name} disabled={disabled}
              onChange={(e) => setBits('driver1', { name: e.target.value })} />
          </TmsField>
        )}
        <TmsField label={LABEL.carrier.driver1Cell.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.driver1Cell)} type="tel" value={value.driver1.phone} disabled={disabled} readOnly={own}
            onChange={(e) => setBits('driver1', { phone: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.driver1Email.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.driver1Email)} type="email" value={value.driver1.email} disabled={disabled} readOnly={own}
            onChange={(e) => setBits('driver1', { email: e.target.value })} />
        </TmsField>

        {!own && (
          <>
            <TmsField label={LABEL.carrier.driver2.text}>
              <TmsInput {...fieldAttrs(LABEL.carrier.driver2)} value={value.driver2.name} disabled={disabled}
                onChange={(e) => setBits('driver2', { name: e.target.value })} />
            </TmsField>
            <TmsField label={LABEL.carrier.driver2Cell.text}>
              <TmsInput {...fieldAttrs(LABEL.carrier.driver2Cell)} type="tel" value={value.driver2.phone} disabled={disabled}
                onChange={(e) => setBits('driver2', { phone: e.target.value })} />
            </TmsField>
            <TmsField label={LABEL.carrier.driver2Email.text}>
              <TmsInput {...fieldAttrs(LABEL.carrier.driver2Email)} type="email" value={value.driver2.email} disabled={disabled}
                onChange={(e) => setBits('driver2', { email: e.target.value })} />
            </TmsField>
          </>
        )}

        <TmsField label={LABEL.carrier.truckNo.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.truckNo)} maxLength={40} value={value.truckNo} disabled={disabled}
            onChange={(e) => set({ truckNo: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.trailerNo.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.trailerNo)} maxLength={40} value={value.trailerNo} disabled={disabled}
            onChange={(e) => set({ trailerNo: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.seal.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.seal)} maxLength={40} value={value.seal} disabled={disabled}
            onChange={(e) => set({ seal: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.carrierRef.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.carrierRef)} maxLength={40} value={value.carrierRef} disabled={disabled}
            onChange={(e) => set({ carrierRef: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.originCity.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.originCity)} value={value.originCity} disabled={disabled}
            onChange={(e) => set({ originCity: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.originState.text}>
          <TmsSelect
            {...fieldAttrs(LABEL.carrier.originState)}
            value={value.originState}
            disabled={disabled}
            placeholder=""
            onChange={(e) => set({ originState: e.target.value })}
            options={US_STATES.map((s) => ({ value: s, label: s }))}
          />
        </TmsField>
        <TmsField label={LABEL.carrier.emptyMiles.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.emptyMiles)} type="number" min={0} value={value.emptyMiles} disabled={disabled}
            onChange={(e) => set({ emptyMiles: e.target.value })} />
        </TmsField>
        <TmsField label={LABEL.carrier.puEta.text}>
          <TmsInput {...fieldAttrs(LABEL.carrier.puEta)} type="datetime-local" value={value.puEta} disabled={disabled}
            onChange={(e) => set({ puEta: e.target.value })} />
        </TmsField>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Static def={LABEL.carrier.confirmSent} text={dash(active?.rateConSentAt)} />
        <Static def={LABEL.carrier.confirmRec} text={dash(active?.rateConSignedAt)} />
        <div className="flex items-end gap-2">
          <Static def={LABEL.carrier.dispatched} text={dash(active?.dispatchedAt)} />
          <TmsButton size="sm" data-testid="carrier-dispatch" disabled={disabled || !active} title={active ? undefined : 'Cover a carrier first'} onClick={ctx.actions.openDispatch}>
            Dispatch
          </TmsButton>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <TmsButton size="sm" data-testid={LABEL.carrier.sendRateConf.testId} disabled={disabled || !active} title={active ? needSave : 'Cover a carrier first'} onClick={ctx.actions.openSendRateCon}>
          {LABEL.carrier.sendRateConf.text}
        </TmsButton>
        <TmsButton size="sm" data-testid={LABEL.carrier.sendInfo.testId} disabled={disabled || !active} title={active ? needSave : 'Cover a carrier first'} onClick={ctx.actions.openSendInfo}>
          {LABEL.carrier.sendInfo.text}
        </TmsButton>
      </div>
    </div>
  )
}

export const CarrierInformationSection = memo(CarrierInformationSectionImpl)
