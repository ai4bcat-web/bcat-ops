import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { formatVin } from '@/lib/utils'
import { activeUnits } from '@/lib/fleetActive'
import type { EquipmentType, FleetGroup, Ownership } from '@/types/equipment'
import { WizardStepper, type WizardStep } from '../shared/WizardStepper'
import '../shared/profiles.css'
import { ASSET_FLEET_OPTIONS, assetBasicsErrors, assetFleetLabel, assetNoun, assetSlots, OWNERSHIP_LABEL } from '../assetProfileModel'

const STEPS: WizardStep[] = [
  { key: 'basics', label: 'Basics' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'assignment', label: 'Assignment' },
  { key: 'documents', label: 'Documents' },
  { key: 'review', label: 'Review' },
]

/**
 * Profiles ▸ Assets ▸ Add truck / Add trailer. Five short steps; the unit is created through the same
 * store call the Trucks page uses, the driver pairing through the same assignment calls. Documents are
 * listed here and uploaded on the new profile, which opens on that tab. Operating costs (loan, plates,
 * ELD) can be added from Edit details on the profile.
 */
export function NewAssetWizard() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { isAdmin } = useAuth()
  const type: EquipmentType = params.get('type') === 'trailer' ? 'trailer' : 'truck'
  const isTruck = type === 'truck'
  const noun = assetNoun(type)
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)

  const [step, setStep] = useState(0)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [unitNumber, setUnitNumber] = useState('')
  const [nickname, setNickname] = useState('')
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [year, setYear] = useState('')
  const [vin, setVin] = useState('')
  const [plate, setPlate] = useState('')
  const [ownership, setOwnership] = useState<Ownership>('owned')
  const [fleet, setFleet] = useState<FleetGroup | ''>('')
  const [dot, setDot] = useState('')
  const [insExp, setInsExp] = useState('')
  const [iftaExp, setIftaExp] = useState('')
  const [irpExp, setIrpExp] = useState('')
  const [driverId, setDriverId] = useState('')

  const units = useMemo(() => equipment.filter((e) => e.type === type).map((e) => e.unitNumber), [equipment, type])
  const errors = assetBasicsErrors({ unitNumber, make, model, year, vin, plate, dotInspectionDate: dot, insuranceExpirationDate: insExp, iftaExpirationDate: iftaExp, irpExpirationDate: irpExp }, units)
  const stepOneBlock = errors.unitNumber ?? errors.year ?? errors.vin ?? null
  const stepTwoBlock = errors.dotInspectionDate ?? errors.insuranceExpirationDate ?? errors.iftaExpirationDate ?? errors.irpExpirationDate ?? null
  const required = assetSlots(type, fleet || null, isAdmin).filter((s) => s.required)
  const blocked = step === 0 ? stepOneBlock : step === 1 ? stepTwoBlock : null
  const next = () => { if (blocked) { setTried(true); return } setTried(false); setStep((s) => s + 1) }
  const activeDrivers = drivers.filter((d) => d.active && (d.type ?? 'driver') !== 'broker').sort((a, b) => a.name.localeCompare(b.name))
  const driverName = activeDrivers.find((d) => d.id === driverId)?.name

  const finish = async () => {
    setBusy(true)
    const state = useAppStore.getState()
    let created
    try {
      created = state.addEquipment({
        type, unitNumber: unitNumber.trim(), nickname: nickname.trim() || undefined,
        make: make.trim(), model: model.trim(), year: year.trim() ? parseInt(year, 10) : undefined,
        plate: plate.trim() || undefined, vin: formatVin(vin) || undefined,
        ownership, insured: true, active: true, onTollwayAccount: false,
        dotInspectionDate: dot || null, insuranceExpirationDate: insExp || undefined,
        iftaExpirationDate: isTruck ? (iftaExp || undefined) : undefined, irpExpirationDate: isTruck ? (irpExp || undefined) : undefined,
        eldSource: isTruck ? 'motive' : undefined, fleetGroup: isTruck ? (fleet || null) : null,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not create the ${noun.toLowerCase()}`)
      setBusy(false)
      return
    }
    const problems: string[] = []
    if (driverId) {
      try {
        if (isTruck) await state.assignTruckToDriver(created.id, driverId)
        else await state.updateDriver(driverId, { assignedTrailerId: created.id, bobtail: false })
      } catch { problems.push('the driver') }
    }
    if (problems.length > 0) toast.warning(`${noun} ${created.unitNumber} was added, but ${problems.join(' and ')} could not be saved. Finish it on the profile.`)
    else toast.success(`${noun} ${created.unitNumber} added`)
    navigate(`/profiles/assets/${created.id}?tab=documents`)
  }

  return (
    <TmsScrollPage title={`Add ${noun.toLowerCase()}`} subtitle="Five short steps. You can change anything later on the profile." data-testid="asset-wizard">
      <WizardStepper
        steps={STEPS}
        current={step}
        canNext
        onBack={() => { setTried(false); setStep((s) => Math.max(0, s - 1)) }}
        onNext={next}
        onFinish={() => void finish()}
        finishLabel={`Create ${noun.toLowerCase()}`}
        busy={busy}
        onCancel={() => navigate(`/profiles/assets?tab=${type}`)}
      >
        {step === 0 && (
          <div className="pf-form-grid">
            <TmsField label="Unit number" error={tried ? errors.unitNumber : null}><TmsInput value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} autoFocus /></TmsField>
            <TmsField label="Nickname" hint="Optional"><TmsInput value={nickname} onChange={(e) => setNickname(e.target.value)} /></TmsField>
            <TmsField label="Make" hint="Optional"><TmsInput value={make} onChange={(e) => setMake(e.target.value)} placeholder={isTruck ? 'Freightliner' : 'Great Dane'} /></TmsField>
            <TmsField label="Model" hint="Optional"><TmsInput value={model} onChange={(e) => setModel(e.target.value)} /></TmsField>
            <TmsField label="Year" hint="Optional" error={tried ? errors.year : null}><TmsInput value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" /></TmsField>
            <TmsField label="VIN" hint="Optional, 17 characters" error={tried ? errors.vin : null}><TmsInput value={vin} onChange={(e) => setVin(e.target.value)} /></TmsField>
            <TmsField label="Plate" hint="Optional"><TmsInput value={plate} onChange={(e) => setPlate(e.target.value)} /></TmsField>
            <TmsField label="Ownership">
              <TmsSelect value={ownership} onChange={(e) => setOwnership(e.target.value as Ownership)} options={Object.entries(OWNERSHIP_LABEL).map(([value, label]) => ({ value, label }))} />
            </TmsField>
            {isTruck ? (
              <div className="pf-wide">
                <div className="tms-field-label" style={{ marginBottom: 6 }}>Fleet</div>
                <div className="pf-chip-pick" role="group" aria-label="Fleet">
                  {ASSET_FLEET_OPTIONS.map((o) => (
                    <button key={o.value} type="button" aria-pressed={fleet === o.value} onClick={() => setFleet(o.value)}>{o.label}</button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {step === 1 && (
          <div className="pf-form-grid">
            <TmsField label="DOT inspection date" hint="Optional. Date of the last inspection." error={tried ? errors.dotInspectionDate : null}><TmsInput type="date" value={dot} onChange={(e) => setDot(e.target.value)} /></TmsField>
            <TmsField label="Insurance expires" hint="Optional" error={tried ? errors.insuranceExpirationDate : null}><TmsInput type="date" value={insExp} onChange={(e) => setInsExp(e.target.value)} /></TmsField>
            {isTruck ? (
              <>
                <TmsField label="IFTA expires" hint="Optional" error={tried ? errors.iftaExpirationDate : null}><TmsInput type="date" value={iftaExp} onChange={(e) => setIftaExp(e.target.value)} /></TmsField>
                <TmsField label="IRP expires" hint="Optional" error={tried ? errors.irpExpirationDate : null}><TmsInput type="date" value={irpExp} onChange={(e) => setIrpExp(e.target.value)} /></TmsField>
              </>
            ) : null}
          </div>
        )}

        {step === 2 && (
          <div className="pf-form-grid">
            <TmsField
              label={isTruck ? 'Driver' : 'Driver who pulls it'}
              hint={isTruck ? 'Optional. Choosing a driver who has another truck moves them to this one.' : 'Optional. Replaces the trailer that driver pulls now.'}
            >
              <TmsSelect value={driverId} onChange={(e) => setDriverId(e.target.value)} placeholder="Not assigned yet" options={activeDrivers.map((d) => ({ value: d.id, label: d.name }))} />
            </TmsField>
            {isTruck ? <div className="pf-row-sub pf-wide">{activeUnits(equipment, 'trailer').length} trailers are active. Pair a trailer with the driver from the driver’s profile or the trailer’s.</div> : null}
          </div>
        )}

        {step === 3 && (
          <div>
            <p style={{ marginTop: 0, fontSize: 13 }}>{isTruck ? `${assetFleetLabel(fleet || null)} trucks` : 'Trailers'} need these on file. You will land on the Documents tab after creating it to upload them.</p>
            <div className="pf-rows" data-testid="wizard-docs">
              {required.map((s) => (
                <div className="pf-row" key={s.key}>
                  <div className="pf-row-main"><div className="pf-row-title">{s.label}</div><div className="pf-row-sub">{s.sub}{s.expires ? ' · has an expiry date' : ''}</div></div>
                </div>
              ))}
              {required.length === 0 ? <div className="pf-empty">Nothing is required for this type.</div> : null}
            </div>
          </div>
        )}

        {step === 4 && (
          <dl className="pf-review" data-testid="wizard-review">
            <dt>{noun}</dt><dd>{unitNumber.trim()}{nickname.trim() ? ` · ${nickname.trim()}` : ''}{isTruck && fleet ? ` · ${assetFleetLabel(fleet)}` : ''}</dd>
            <dt>Details</dt><dd>{[year.trim(), make.trim(), model.trim()].filter(Boolean).join(' ') || 'Not entered'}{vin.trim() ? ` · VIN ${formatVin(vin)}` : ''}{plate.trim() ? ` · plate ${plate.trim()}` : ''}</dd>
            <dt>Ownership</dt><dd>{OWNERSHIP_LABEL[ownership]}</dd>
            <dt>Compliance</dt><dd>{[dot ? `DOT ${dot}` : null, insExp ? `insurance ${insExp}` : null, iftaExp ? `IFTA ${iftaExp}` : null, irpExp ? `IRP ${irpExp}` : null].filter(Boolean).join(' · ') || 'No dates entered'}</dd>
            <dt>Driver</dt><dd>{driverName ?? 'Not assigned yet'}</dd>
            <dt>Documents</dt><dd>{required.length} required, uploaded next</dd>
          </dl>
        )}
      </WizardStepper>
    </TmsScrollPage>
  )
}
