import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Pencil } from 'lucide-react'
import {
  TmsAlert, TmsBadge, TmsButton, TmsEmptyState, TmsField, TmsProfileHeader, TmsSegmentedTabs, TmsSelect,
} from '@/features/tms/kit'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { DriverDrawer } from '@/features/drivers/DriverDrawer'
import { ResetDriverPassword } from '@/features/driver-login/ResetDriverPassword'
import { SettingsModal as AmazonPaySettings } from '@/features/driver-pay/DriverPayForms'
import { SettingsModal as BoxTruckPaySettings } from '@/features/driver-pay-box-trucks/BoxTruckPayForms'
import { SettingsModal as OwnerOperatorPaySettings } from '@/features/owner-operator-pay/OwnerOperatorPayForms'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { activeUnits } from '@/lib/fleetActive'
import { earnsPto, needsHireDate } from '@/lib/ptoAllowance'
import { driverExpiryPatch, driverExpiry, slotsForDriver, visibleSlots } from '@/lib/fileHub'
import * as api from '@/lib/apiClient'
import { driverTrailerFieldDeployed } from '@/lib/apiClient'
import { ProfileDocuments } from '../shared/ProfileDocuments'
import { ProfileRows, ProfileSection } from '../shared/ProfileSection'
import '../shared/profiles.css'
import { useDriverPaySettings, type PaySettingPatch } from './useDriverPaySettings'
import { PayModeSection } from './PayModeSection'
import { currentFixedExpenses, docsSummary, fleetLabel, missingDriverFields, payLines, settlementLink, trailerModeFor } from '../driverProfileModel'

type TabKey = 'overview' | 'pay' | 'equipment' | 'documents' | 'activity'
const TAB_KEYS: TabKey[] = ['overview', 'pay', 'equipment', 'documents', 'activity']

const yesNo = (v: boolean | null | undefined, whenNull = 'By fleet') => (v == null ? whenNull : v ? 'Yes' : 'No')

/** Profiles ▸ Drivers ▸ one driver. Edits the same records the old pages edit; nothing is copied. */
export function DriverProfilePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { user, isAdmin } = useAuth()
  const driver = useAppStore((s) => s.drivers.find((d) => d.id === id))
  const equipment = useAppStore((s) => s.equipment)
  const loads = useAppStore((s) => s.loads)
  const updateDriver = useAppStore((s) => s.updateDriver)
  const hub = useFileHub()
  const pay = useDriverPaySettings()
  const [editing, setEditing] = useState(false)
  const [payOpen, setPayOpen] = useState(false)

  const rawTab = params.get('tab') as TabKey | null
  const tab: TabKey = rawTab && TAB_KEYS.includes(rawTab) ? rawTab : 'overview'
  // The pay weeks this driver still has Amazon trips in: the Pay mode section flags such a week from the changeover on (it needs a decision).
  const [amazonWeeks, setAmazonWeeks] = useState<ReadonlySet<string>>(new Set())
  const amazonDriverId = driver?.id
  useEffect(() => {
    if (!amazonDriverId || tab !== 'pay') return
    let live = true
    void (async () => {
      try {
        const trips = await api.listAmazonTrips()
        if (live) setAmazonWeeks(new Set(trips.filter((t) => t.driverId === amazonDriverId).map((t) => t.periodStart)))
      } catch { /* the flag is a courtesy; the section works without it */ }
    })()
    return () => { live = false }
  }, [amazonDriverId, tab])
  const setTab = (next: string) => setParams(next === 'overview' ? {} : { tab: next }, { replace: true })

  const truck = driver?.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
  const trailer = driver?.assignedTrailerId ? equipment.find((e) => e.id === driver.assignedTrailerId) : undefined
  const setting = driver ? pay.byDriver.get(driver.id) : undefined
  const slots = useMemo(() => visibleSlots(slotsForDriver(driver?.fleetGroup), isAdmin), [driver?.fleetGroup, isAdmin])
  const docs = driver ? docsSummary(driver.fleetGroup, (key) => hub.stateFor('DRIVER', driver.id, key), isAdmin) : null
  const recentLoads = useMemo(() => (driver
    ? loads
      .filter((l) => l.pickupDriverId === driver.id || l.deliveryDriverId === driver.id)
      .sort((a, b) => (b.deliveryAppt ?? '').localeCompare(a.deliveryAppt ?? ''))
      .slice(0, 12)
    : []), [loads, driver])

  if (!driver || !docs) {
    return (
      <TmsScrollPage title="Driver">
        <TmsEmptyState title="Driver not found" message="They may have been removed, or the list is still loading." actionLabel="Back to drivers" onAction={() => navigate('/profiles/drivers')} />
      </TmsScrollPage>
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  const cdl = driverExpiry(driver.cdlExpiration, hub.docFor('DRIVER', driver.id, 'cdl_copy'))
  const med = driverExpiry(driver.medCardExpiration, hub.docFor('DRIVER', driver.id, 'medical_card'))
  const settle = settlementLink(driver.fleetGroup)
  const trailerMode = trailerModeFor(driver.fleetGroup)
  const trucks = activeUnits(equipment, 'truck')
  const trailers = activeUnits(equipment, 'trailer')

  const savePay = async (patch: PaySettingPatch, expectedUpdatedAt: string | undefined) => {
    await pay.save(driver.id, patch, expectedUpdatedAt)
    // The settlement e-mail and the driver record each hold an address; fill the driver's if blank, as the settlement pages do.
    if (patch.email?.trim() && !driver.email?.trim()) {
      try { await updateDriver(driver.id, { email: patch.email.trim() }) } catch { /* the pay setting is saved; the mirror is a convenience */ }
    }
    toast.success('Pay settings saved')
    setPayOpen(false)
  }

  // Same save path, without the 'Pay settings saved' toast or closing the editor (the pay-mode section has its own message).
  const savePayQuiet = (patch: PaySettingPatch, expectedUpdatedAt: string | undefined) => pay.save(driver.id, patch, expectedUpdatedAt)

  const assignTruck = async (truckId: string) => {
    try {
      if (truckId) await useAppStore.getState().assignTruckToDriver(truckId, driver.id)
      else if (driver.assignedTruckId) await useAppStore.getState().assignTruckToDriver(driver.assignedTruckId, null)
      toast.success(truckId ? 'Truck assigned' : 'Truck released')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not change the truck') }
  }
  const assignTrailer = async (trailerId: string) => {
    try {
      await updateDriver(driver.id, trailerId ? { assignedTrailerId: trailerId, bobtail: false } : { assignedTrailerId: null })
      toast.success(trailerId ? 'Trailer assigned' : 'Trailer cleared')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not change the trailer') }
  }

  const payModal = payOpen ? (() => {
    const common = { driver, existing: setting, onSave: savePay, onClose: () => setPayOpen(false) }
    if (driver.fleetGroup === 'BOX_TRUCK') return <BoxTruckPaySettings {...common} />
    if (driver.fleetGroup === 'OWNER_OPERATOR') return <OwnerOperatorPaySettings {...common} />
    return <AmazonPaySettings {...common} />
  })() : null
  const percentPaid = driver.fleetGroup === 'BOX_TRUCK' || driver.fleetGroup === 'OWNER_OPERATOR' || driver.fleetGroup === 'AMAZON'
  const lines = payLines(setting, driver.fleetGroup)
  const fixed = currentFixedExpenses(setting, today)

  return (
    <TmsScrollPage
      title={<Link to="/profiles/drivers" className="pf-link"><ArrowLeft size={13} /> Drivers</Link>}
      width="full"
      data-testid="driver-profile"
    >
      <TmsProfileHeader
        as="h1"
        name={driver.name}
        chips={(
          <>
            <TmsBadge tone={driver.active ? 'green' : 'gray'}>{driver.active ? 'Active' : 'Inactive'}</TmsBadge>
            <TmsBadge tone="blue">{fleetLabel(driver.fleetGroup)}</TmsBadge>
            <TmsBadge tone={docs.tone}>Docs: {docs.label}</TmsBadge>
            {missingDriverFields(driver).length > 0 ? (
              <span title={`Missing: ${missingDriverFields(driver).join(', ')}`} data-testid="driver-missing-fields">
                <TmsBadge tone="orange">Missing: {missingDriverFields(driver).join(', ')}</TmsBadge>
              </span>
            ) : null}
          </>
        )}
        subtitle={(
          <span className="pf-head-meta">
            <span>{driver.phone}</span>
            {driver.email ? <span>{driver.email}</span> : null}
            <span>{truck ? <>Truck <strong>{truck.unitNumber}</strong></> : 'No truck'}</span>
            {trailer ? <span>Trailer <strong>{trailer.unitNumber}</strong></span> : driver.bobtail ? <span>Bobtail</span> : null}
          </span>
        )}
        actions={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <ResetDriverPassword driver={driver} />
            <TmsButton onClick={() => setEditing(true)} data-testid="driver-edit"><Pencil size={14} /> Edit details</TmsButton>
          </span>
        )}
      />

      {needsHireDate(driver) ? (
        <TmsAlert tone="orange" title={earnsPto(driver) ? 'Hire date needed for PTO' : 'Hire date needed'} className="pf-hire-alert" >
          {earnsPto(driver)
            ? <>PTO is counted from the hire date, so {driver.name.split(' ')[0]} has no PTO balance and no PTO in the driver app until it is filled in.</>
            : <>{driver.name.split(' ')[0]}'s file has no hire date (first day of work).</>}{' '}
          <button type="button" className="pf-link" onClick={() => setEditing(true)} data-testid="driver-add-hire-date">Add hire date</button>
        </TmsAlert>
      ) : null}

      <div className="pf-tabs" style={{ marginTop: 16 }}>
        <TmsSegmentedTabs
          aria-label="Driver profile"
          active={tab}
          onSelect={setTab}
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'pay', label: 'Pay' },
            { key: 'equipment', label: 'Equipment' },
            { key: 'documents', label: 'Documents', count: docs.missing + docs.attention || undefined },
            { key: 'activity', label: 'Activity' },
          ]}
        />
      </div>

      {tab === 'overview' && (
        <div className="pf-body">
          <div className="pf-main">
            <ProfileSection title="Contact & dispatch" action={<TmsButton size="sm" onClick={() => setEditing(true)}>Edit</TmsButton>}>
              <ProfileRows rows={[
                { label: 'Phone', value: driver.phone },
                { label: 'E-mail', value: driver.email ?? '' },
                { label: 'Primary dispatcher', value: driver.dispatcherPrimary ?? '' },
                { label: 'Backup dispatcher', value: driver.dispatcherBackup ?? '' },
                { label: 'Hire date', value: driver.hireDate ?? '', hint: needsHireDate(driver) ? (earnsPto(driver) ? 'Needed for PTO' : 'Needed') : undefined },
              ]} />
            </ProfileSection>
            <ProfileSection title="Licence & medical" action={<TmsButton size="sm" onClick={() => setEditing(true)}>Edit</TmsButton>}>
              <ProfileRows rows={[
                { label: 'CDL number', value: driver.cdl ?? '' },
                { label: 'CDL expires', value: cdl.date ?? '', hint: cdl.conflict ? `The uploaded document says ${cdl.documentDate}` : undefined },
                { label: 'Medical card expires', value: med.date ?? '', hint: med.conflict ? `The uploaded document says ${med.documentDate}` : undefined },
                { label: 'Last drug test', value: driver.drugTestDate ?? '' },
              ]} />
            </ProfileSection>
            <ProfileSection title="Notes"><div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{driver.notes?.trim() || <span className="tms-muted">No notes.</span>}</div></ProfileSection>
          </div>
          <div className="pf-side">
            <ProfileSection title="Program">
              <ProfileRows rows={[
                { label: 'Driver type', value: fleetLabel(driver.fleetGroup) },
                { label: 'Ivan paperwork app', value: yesNo(driver.ivanApp) },
                { label: 'Time clock', value: yesNo(driver.timeClock) },
                { label: 'PTO eligible', value: yesNo(driver.ptoEligible, 'No') },
                { label: 'Unit type', value: driver.unitType ? driver.unitType.replace('_', ' ').toLowerCase() : 'By fleet' },
                { label: 'Motive user id', value: driver.motiveDriverId != null ? String(driver.motiveDriverId) : '' },
              ]} />
            </ProfileSection>
            <ProfileSection title="Compliance">
              <ProfileRows rows={[
                { label: 'Onboarding', value: (driver.onboardingStatus ?? '').replace(/_/g, ' ').toLowerCase() },
                { label: 'Compliance', value: (driver.complianceStatus ?? '').replace(/_/g, ' ').toLowerCase() },
              ]} />
            </ProfileSection>
          </div>
        </div>
      )}

      {tab === 'pay' && (
        <div className="pf-body">
          <div className="pf-main">
            <ProfileSection
              title="Pay settings"
              action={driver.fleetGroup && percentPaid
                ? <TmsButton size="sm" variant="primary" onClick={() => setPayOpen(true)} data-testid="pay-edit">{setting ? 'Edit pay settings' : 'Set up pay'}</TmsButton>
                : null}
            >
              {!driver.fleetGroup ? (
                <div className="pf-empty">Choose this driver’s type first (Edit details), then their pay can be set up.</div>
              ) : lines.length === 0 ? (
                <div className="pf-empty">No pay settings yet. {percentPaid ? 'Use “Set up pay” to add the percentage, fuel card and fixed expenses.' : ''}</div>
              ) : (
                <ProfileRows rows={lines.map((l) => ({ label: l.label, value: l.value }))} />
              )}
              {driver.fleetGroup === 'LOCAL' ? (
                <div className="pf-row-sub" style={{ marginTop: 8 }}>Local drivers are paid by the hour from their time card. The hourly rate is changed on <Link className="pf-link" to="/hours">Employee hours</Link>.</div>
              ) : null}
            </ProfileSection>
            {setting && (driver.fleetGroup === 'OWNER_OPERATOR' || driver.fleetGroup === 'AMAZON' || setting.payGroup === 'OWNER_OPERATOR' || setting.payGroup === 'AMAZON') ? (
              <PayModeSection setting={setting} today={today} onSave={savePayQuiet} amazonWeeks={amazonWeeks} />
            ) : null}
            <ProfileSection title="Fixed weekly expenses">
              {fixed.length === 0
                ? <div className="pf-empty">None in force today.</div>
                : <ProfileRows rows={fixed.map((f) => ({ label: f.label, value: `$${f.amount.toFixed(2)}` }))} />}
            </ProfileSection>
          </div>
          <div className="pf-side">
            <ProfileSection title="Settlements">
              <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
                <span>Weekly checks, credits and deductions are managed with each settlement.</span>
                {settle ? <Link className="pf-link" to={settle.to}>Open {settle.label.toLowerCase()}</Link> : <span className="tms-muted">Set the driver type to see their settlement page.</span>}
              </div>
            </ProfileSection>
          </div>
        </div>
      )}

      {tab === 'equipment' && (
        <div className="pf-body">
          <div className="pf-main">
            <ProfileSection title={trailerMode === 'none' ? 'Truck' : 'Truck & trailer'}>
              <div className="pf-form-grid">
                <TmsField label="Truck">
                  <TmsSelect
                    value={driver.assignedTruckId ?? ''}
                    onChange={(e) => void assignTruck(e.target.value)}
                    options={trucks.map((t) => ({ value: t.id, label: `Truck ${t.unitNumber}${t.nickname ? ` · ${t.nickname}` : ''}` }))}
                    placeholder="No truck"
                  />
                </TmsField>
                {trailerMode === 'none' ? null : (
                <TmsField
                  label={trailerMode === 'standing' ? 'Standing trailer' : 'Trailer today'}
                  hint={!driverTrailerFieldDeployed() ? 'Trailer assignment is not switched on yet.' : trailerMode === 'standing' ? 'Optional. An owner operator generally keeps one trailer.' : 'Optional. Company drivers take a trailer from the pool each day.'}
                >
                  <TmsSelect
                    value={driver.assignedTrailerId ?? ''}
                    onChange={(e) => void assignTrailer(e.target.value)}
                    disabled={!driverTrailerFieldDeployed()}
                    options={trailers.map((t) => ({ value: t.id, label: `Trailer ${t.unitNumber}` }))}
                    placeholder={driver.bobtail ? 'Bobtail (no trailer)' : trailerMode === 'pool' ? 'From the pool' : 'No trailer set'}
                  />
                </TmsField>
                )}
              </div>
            </ProfileSection>
            {truck ? (
              <ProfileSection title={`Truck ${truck.unitNumber}`} action={<Link className="pf-link" to="/truck-docs">Truck documents</Link>}>
                <ProfileRows rows={[
                  { label: 'Make / model', value: [truck.year, truck.make, truck.model].filter(Boolean).join(' ') },
                  { label: 'VIN', value: truck.vin ?? '' },
                  { label: 'Plate', value: truck.plate ?? '' },
                  { label: 'Fuel cards', value: (truck.fuelCardNumbers ?? []).join(', ') },
                ]} />
              </ProfileSection>
            ) : null}
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <ProfileSection title={`Required documents · ${fleetLabel(driver.fleetGroup)}`} testId="driver-documents">
          <ProfileDocuments
            entityType="DRIVER"
            entityId={driver.id}
            slots={slots}
            hub={hub}
            stateOf={(key) => hub.stateFor('DRIVER', driver.id, key)}
            uploadedBy={user?.email ?? null}
            expiryDefault={(slot) => (slot.key === 'cdl_copy' ? driver.cdlExpiration : slot.key === 'medical_card' ? driver.medCardExpiration : null)}
            onUploaded={async (slot, expiration) => {
              const patch = driverExpiryPatch(slot.key, expiration)
              if (patch) await updateDriver(driver.id, patch)
            }}
          />
        </ProfileSection>
      )}

      {tab === 'activity' && (
        <ProfileSection title="Recent loads">
          {recentLoads.length === 0 ? <div className="pf-empty">No loads on record for this driver.</div> : (
            <div className="pf-rows">
              {recentLoads.map((l) => (
                <div className="pf-row" key={l.id}>
                  <div className="pf-row-main">
                    <div className="pf-row-title">{l.aljexId} · {l.customer ?? 'No customer'}</div>
                    <div className="pf-row-sub">{[l.originCity, l.destinationCity].filter(Boolean).join(' → ')}</div>
                  </div>
                  <span className="pf-row-sub">{(l.deliveryAppt ?? '').slice(0, 10)}</span>
                </div>
              ))}
            </div>
          )}
        </ProfileSection>
      )}

      {editing ? <DriverDrawer open driver={driver} onClose={() => setEditing(false)} /> : null}
      {payModal}
    </TmsScrollPage>
  )
}
