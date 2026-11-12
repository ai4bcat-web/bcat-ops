import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { activeUnits } from '@/lib/fleetActive'
import { createDriverPaySetting } from '@/lib/apiClient'
import { withRateChange } from '@/lib/hoursPay'
import type { ColorKey } from '@/types'
import type { DriverFleet } from '@/types/equipment'
import { WizardStepper, type WizardStep } from '../shared/WizardStepper'
import '../shared/profiles.css'
import {
  basicsErrors, FLEET_OPTIONS, fleetLabel, hourlyRateError, normalizePhone, payError, requiredDocsFor, wizardPayDefaults,
} from '../driverProfileModel'

const STEPS: WizardStep[] = [
  { key: 'basics', label: 'Basics' },
  { key: 'pay', label: 'Pay' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'documents', label: 'Documents' },
  { key: 'review', label: 'Review' },
]

const COLORS: ColorKey[] = ['driver-1', 'driver-2', 'driver-3', 'driver-4', 'driver-5', 'driver-6', 'driver-7', 'driver-8', 'driver-9', 'driver-10', 'driver-11', 'driver-12']

/**
 * Profiles ▸ Drivers ▸ Add driver. Five short steps; the driver, their pay setting and their
 * equipment are created through the same calls the driver editor and the settlement pages use.
 * Documents are listed here and uploaded on the new profile, which opens on that tab.
 */
export function NewDriverWizard() {
  const navigate = useNavigate()
  const { isAdmin, user } = useAuth()
  const drivers = useAppStore((s) => s.drivers)
  const equipment = useAppStore((s) => s.equipment)

  const [step, setStep] = useState(0)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [fleet, setFleet] = useState<DriverFleet | ''>('')
  const [dispatcher, setDispatcher] = useState('')
  const [cdl, setCdl] = useState('')
  const [cdlExpiration, setCdlExpiration] = useState('')
  const [hireDate, setHireDate] = useState('')
  const [medCardExpiration, setMedCardExpiration] = useState('')
  const [hourly, setHourly] = useState('')
  const [percent, setPercent] = useState('')
  const [afterExpenses, setAfterExpenses] = useState(false)
  const [fuelCard, setFuelCard] = useState('')
  const [truckId, setTruckId] = useState('')
  const [trailerId, setTrailerId] = useState('')

  const dispatchers = useMemo(() => Array.from(new Set(
    drivers.flatMap((d) => [d.dispatcherPrimary ?? '', d.dispatcherBackup ?? '']).map((e) => e.trim().toLowerCase()).filter(Boolean),
  )).sort(), [drivers])
  // Trucks already held by a driver are offered too: assigning moves the truck, exactly as the driver editor does.
  const trucks = activeUnits(equipment, 'truck')
  const trailers = activeUnits(equipment, 'trailer')
  const takenBy = (id: string) => drivers.find((d) => d.assignedTruckId === id)?.name

  const defaults = wizardPayDefaults(fleet || null)
  const errors = basicsErrors({ name, phone, email, fleet, cdl, cdlExpiration, hireDate, medCardExpiration })
  const payProblem = defaults.percentPaid ? payError(fleet, percent) : hourlyRateError(hourly)
  const required = requiredDocsFor(fleet || null, isAdmin)

  const pickFleet = (next: DriverFleet) => {
    setFleet(next)
    const d = wizardPayDefaults(next)
    setPercent(d.percent)
    setAfterExpenses(d.afterExpenses)
  }

  const blocked = step === 0 ? (Object.values(errors)[0] ?? null) : step === 1 ? payProblem : null
  const next = () => { if (blocked) { setTried(true); return } setTried(false); setStep((s) => s + 1) }

  const finish = async () => {
    if (!fleet) return
    setBusy(true)
    const state = useAppStore.getState()
    let driverId: string
    try {
      const created = await state.addDriver({
        name: name.trim(), phone: normalizePhone(phone), active: true, type: 'driver',
        colorKey: COLORS[Math.floor(Math.random() * COLORS.length)],
        email: email.trim() || undefined, fleetGroup: fleet,
        cdl: cdl.trim() || undefined, cdlExpiration: cdlExpiration || undefined,
        hireDate: hireDate || undefined, medCardExpiration: medCardExpiration || undefined,
        dispatcherPrimary: dispatcher || null, assignedTruckId: null, assignedTrailerId: null,
        // NOT_STARTED marks a new hire as onboardable, as in the driver editor.
        onboardingStatus: 'NOT_STARTED',
      })
      driverId = created.id
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the driver')
      setBusy(false)
      return
    }

    // The driver exists from here on; a failed extra is reported and fixable on the profile.
    const problems: string[] = []
    if (defaults.percentPaid) {
      try {
        await createDriverPaySetting({
          driverId, payGroup: fleet, payPercent: parseFloat(percent) / 100, expensesBeforePercent: afterExpenses,
          email: email.trim() || null, fuelCardNumber: fuelCard.trim() || null, fixedExpenses: [], active: true, notes: null,
        })
      } catch { problems.push('pay settings') }
    }
    if (!defaults.percentPaid && hourly.trim()) {
      // The same row and rate history the Employee hours page writes (useHourlyRates.saveRate for a first rate).
      try {
        const rate = parseFloat(hourly.replace(/[$,\s]/g, ''))
        const startsOn = hireDate || new Date().toISOString().slice(0, 10)
        await createDriverPaySetting({
          driverId, payGroup: 'LOCAL', payPercent: 0, expensesBeforePercent: false, active: true,
          ...withRateChange({}, rate, startsOn, user?.email ?? '', new Date().toISOString()),
        })
      } catch { problems.push('the hourly rate') }
    }
    if (truckId) {
      try { await state.assignTruckToDriver(truckId, driverId) } catch { problems.push('the truck') }
    }
    if (trailerId) {
      try { await state.updateDriver(driverId, { assignedTrailerId: trailerId, bobtail: false }) } catch { problems.push('the trailer') }
    }
    if (problems.length > 0) toast.warning(`${name.trim()} was added, but ${problems.join(' and ')} could not be saved. Finish it on the profile.`)
    else toast.success(`${name.trim()} added`)
    navigate(`/profiles/drivers/${driverId}?tab=documents`)
  }

  return (
    <TmsScrollPage title="Add driver" subtitle="Five short steps. You can change anything later on the profile." data-testid="driver-wizard">
      <WizardStepper
        steps={STEPS}
        current={step}
        canNext
        onBack={() => { setTried(false); setStep((s) => Math.max(0, s - 1)) }}
        onNext={next}
        onFinish={() => void finish()}
        finishLabel="Create driver"
        busy={busy}
        onCancel={() => navigate('/profiles/drivers')}
      >
        {step === 0 && (
          <div className="pf-form-grid">
            <TmsField label="Full name" error={tried ? errors.name : null}><TmsInput value={name} onChange={(e) => setName(e.target.value)} autoFocus /></TmsField>
            <TmsField label="Phone" error={tried ? errors.phone : null}><TmsInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(312) 555-0100" /></TmsField>
            <TmsField label="E-mail" hint="Where invites and settlement reports go" error={tried ? errors.email : null}><TmsInput value={email} onChange={(e) => setEmail(e.target.value)} /></TmsField>
            <TmsField label="CDL number" hint="Optional"><TmsInput value={cdl} onChange={(e) => setCdl(e.target.value)} placeholder="CDL-A IL-8823901" /></TmsField>
            <TmsField label="CDL expires" hint="Optional" error={tried ? errors.cdlExpiration : null}><TmsInput type="date" value={cdlExpiration} onChange={(e) => setCdlExpiration(e.target.value)} /></TmsField>
            <TmsField label="Med card expires" hint="Optional" error={tried ? errors.medCardExpiration : null}><TmsInput type="date" value={medCardExpiration} onChange={(e) => setMedCardExpiration(e.target.value)} /></TmsField>
            <TmsField label="Hire date" hint="Optional" error={tried ? errors.hireDate : null}><TmsInput type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} /></TmsField>
            <TmsField label="Dispatcher" hint="Optional"><TmsSelect value={dispatcher} onChange={(e) => setDispatcher(e.target.value)} options={dispatchers.map((d) => ({ value: d, label: d }))} placeholder="None yet" /></TmsField>
            <div className="pf-wide">
              <div className="tms-field-label" style={{ marginBottom: 6 }}>Driver type</div>
              <div className="pf-chip-pick" role="group" aria-label="Driver type">
                {FLEET_OPTIONS.map((o) => (
                  <button key={o.value} type="button" aria-pressed={fleet === o.value} onClick={() => pickFleet(o.value)}>{o.label}</button>
                ))}
              </div>
              {tried && errors.fleet ? <div role="alert" style={{ color: 'var(--tms-badge-red)', fontSize: 12, marginTop: 6 }}>{errors.fleet}</div> : null}
            </div>
          </div>
        )}

        {step === 1 && (defaults.percentPaid ? (
          <div className="pf-form-grid">
            <TmsField label="Pay percent" hint="1 to 100" error={tried ? payProblem : null}><TmsInput value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" autoFocus /></TmsField>
            <TmsField label="Fuel card # (EFS)" hint="Optional"><TmsInput value={fuelCard} onChange={(e) => setFuelCard(e.target.value)} /></TmsField>
            <div className="pf-wide">
              <div className="tms-field-label" style={{ marginBottom: 6 }}>Calculation</div>
              <div className="pf-chip-pick" role="group" aria-label="Calculation">
                <button type="button" aria-pressed={!afterExpenses} onClick={() => setAfterExpenses(false)}>% of gross, then minus expenses</button>
                <button type="button" aria-pressed={afterExpenses} onClick={() => setAfterExpenses(true)}>% of net, after expenses</button>
              </div>
            </div>
            <div className="pf-wide pf-row-sub">Fixed weekly expenses can be added on the Pay tab afterwards.</div>
          </div>
        ) : (
          <div className="pf-form-grid">
            <TmsField label="Starting hourly rate" hint={`Optional. Paid from the time card, starting ${hireDate || 'today'}. Change it later on Employee hours.`} error={tried ? payProblem : null}>
              <TmsInput value={hourly} onChange={(e) => setHourly(e.target.value)} inputMode="decimal" placeholder="25.00" autoFocus />
            </TmsField>
          </div>
        ))}

        {step === 2 && (
          <div className="pf-form-grid">
            <TmsField label="Truck" hint="Optional. Choosing a truck another driver has moves it to this driver.">
              <TmsSelect value={truckId} onChange={(e) => setTruckId(e.target.value)} placeholder="No truck yet"
                options={trucks.map((t) => ({ value: t.id, label: `Truck ${t.unitNumber}${takenBy(t.id) ? ` (now ${takenBy(t.id)})` : ''}` }))} />
            </TmsField>
            <TmsField label="Trailer" hint="Optional">
              <TmsSelect value={trailerId} onChange={(e) => setTrailerId(e.target.value)} placeholder="No trailer yet"
                options={trailers.map((t) => ({ value: t.id, label: `Trailer ${t.unitNumber}` }))} />
            </TmsField>
          </div>
        )}

        {step === 3 && (
          <div>
            <p style={{ marginTop: 0, fontSize: 13 }}>{fleetLabel(fleet)} drivers need these on file. You will land on the Documents tab after creating the driver to upload them.</p>
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
            <dt>Driver</dt><dd>{name.trim()} · {fleetLabel(fleet)}</dd>
            <dt>Contact</dt><dd>{normalizePhone(phone)}{email.trim() ? ` · ${email.trim()}` : ''}</dd>
            <dt>Dispatcher</dt><dd>{dispatcher || 'None yet'}</dd>
            <dt>Pay</dt><dd>{defaults.percentPaid ? `${percent}% · ${afterExpenses ? 'after expenses' : 'of gross, then minus expenses'}${fuelCard.trim() ? ` · card ${fuelCard.trim()}` : ''}` : hourly.trim() ? `$${hourly.trim()}/hr (time card)` : 'Hourly (time card), rate not set yet'}</dd>
            <dt>Licence</dt><dd>{[cdl.trim() || null, cdlExpiration ? `CDL expires ${cdlExpiration}` : null, medCardExpiration ? `med card ${medCardExpiration}` : null, hireDate ? `hired ${hireDate}` : null].filter(Boolean).join(' · ') || 'Not entered'}</dd>
            <dt>Equipment</dt><dd>{[truckId ? `Truck ${trucks.find((t) => t.id === truckId)?.unitNumber}` : null, trailerId ? `Trailer ${trailers.find((t) => t.id === trailerId)?.unitNumber}` : null].filter(Boolean).join(' · ') || 'None yet'}</dd>
            <dt>Documents</dt><dd>{required.length} required, uploaded next</dd>
          </dl>
        )}
      </WizardStepper>
    </TmsScrollPage>
  )
}
