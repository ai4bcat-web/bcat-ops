import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowLeft, Pencil, PauseCircle, PlayCircle } from 'lucide-react'
import { TmsBadge, TmsButton, TmsEmptyState, TmsField, TmsProfileHeader, TmsSegmentedTabs, TmsSelect } from '@/features/tms/kit'
import { TmsScrollPage } from '@/features/tms/kit/TmsScrollPage'
import { EquipmentForm } from '@/features/trucks/TrucksPage'
import { saveEquipment } from '@/features/trucks/saveEquipment'
import { MarkInactiveDialog } from '@/features/trucks/TruckParking'
import { TruckPhoneEditor } from '@/features/trucks/TruckPhoneEditor'
import { useAppStore } from '@/store/useAppStore'
import { useAuth } from '@/hooks/useAuth'
import { useFileHub } from '@/hooks/useFileHub'
import { useExpenseData } from '@/hooks/useExpenseData'
import { useTruckConfigs } from '@/hooks/useTruckConfigs'
import { readTruckCosts } from '@/lib/truckCosts'
import { getUnitPremiumCents } from '@/lib/insuranceClient'
import { activeUnits, driversHoldingTrailer, reactivatePatch } from '@/lib/fleetActive'
import { formatPhone, formatVin } from '@/lib/utils'
import { ProfileDocuments } from '../shared/ProfileDocuments'
import { ProfileRows, ProfileSection } from '../shared/ProfileSection'
import '../shared/profiles.css'
import {
  assetDates, assetDocsSummary, assetFleetLabel, assetNoun, assetSlots, assetSlotState, assetTitle, assignedTo, makeModel,
  nextPmMileage, OWNERSHIP_LABEL, slotAsksExpiry,
} from '../assetProfileModel'

const TAB_KEYS = ['overview', 'assignment', 'documents', 'maintenance'] as const
type TabKey = (typeof TAB_KEYS)[number]

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

/** Profiles ▸ Assets ▸ one truck or trailer. Edits write the same Equipment records the Trucks and Asset documents pages use. */
export function AssetProfilePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { user, isAdmin } = useAuth()
  const equipment = useAppStore((s) => s.equipment)
  const drivers = useAppStore((s) => s.drivers)
  const tasks = useAppStore((s) => s.maintenanceTasks)
  const invoices = useAppStore((s) => s.maintenanceInvoices)
  const addEquipment = useAppStore((s) => s.addEquipment)
  const updateEquipment = useAppStore((s) => s.updateEquipment)
  const updateDriver = useAppStore((s) => s.updateDriver)
  const hub = useFileHub()
  const expenseData = useExpenseData()
  const { byId: truckConfigs } = useTruckConfigs()
  const [editing, setEditing] = useState(false)
  const [editPhone, setEditPhone] = useState(false)
  const [parking, setParking] = useState(false)
  const [premium, setPremium] = useState(0)

  const rawTab = params.get('tab') as TabKey | null
  const tab: TabKey = rawTab && TAB_KEYS.includes(rawTab) ? rawTab : 'overview'
  const setTab = (next: string) => setParams(next === 'overview' ? {} : { tab: next }, { replace: true })

  const equip = equipment.find((e) => e.id === id)
  const holders = useMemo(() => (equip ? assignedTo(equip, drivers) : []), [equip, drivers])
  const slots = useMemo(() => (equip ? assetSlots(equip.type, equip.fleetGroup, isAdmin) : []), [equip, isAdmin])
  const myTasks = useMemo(() => tasks.filter((t) => t.equipmentId === id), [tasks, id])
  const myInvoices = useMemo(() => invoices.filter((i) => i.equipmentId === id).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')), [invoices, id])

  if (!equip) {
    return (
      <TmsScrollPage title="Asset">
        <TmsEmptyState title="Asset not found" message="It may have been removed, or the list is still loading." actionLabel="Back to assets" onAction={() => navigate('/profiles/assets')} />
      </TmsScrollPage>
    )
  }

  const isTruck = equip.type === 'truck'
  const docs = assetDocsSummary(equip, hub.docFor, isAdmin)
  const dates = assetDates(equip, hub.docFor)
  const config = truckConfigs.get(equip.id)
  const nextPm = nextPmMileage(equip)
  const driver = isTruck ? holders[0] : undefined
  const tabParam = isTruck ? 'truck' : 'trailer'

  const assignDriver = async (driverId: string) => {
    try {
      if (driverId) await useAppStore.getState().assignTruckToDriver(equip.id, driverId)
      else await useAppStore.getState().assignTruckToDriver(equip.id, null)
      toast.success(driverId ? 'Driver assigned' : 'Truck released')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not change the driver') }
  }
  const setTrailerFor = async (driverId: string, trailerId: string | null) => {
    try {
      await updateDriver(driverId, trailerId ? { assignedTrailerId: trailerId, bobtail: false } : { assignedTrailerId: null })
      toast.success(trailerId ? 'Trailer assigned' : 'Trailer released')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not change the trailer') }
  }
  const openPark = () => {
    if (!equip.active) {
      // Back on the road, as the Trucks page does it.
      updateEquipment(equip.id, reactivatePatch)
      toast.success(`${assetTitle(equip)} is active again`)
      return
    }
    setPremium(0)
    setParking(true)
    getUnitPremiumCents(equip.id).then((c) => setPremium(c / 100)).catch(() => {})
  }

  const trucks = activeUnits(equipment, 'truck')
  const availableDrivers = drivers.filter((d) => d.active && (d.type ?? 'driver') !== 'broker').sort((a, b) => a.name.localeCompare(b.name))
  const driversWithTrailers = availableDrivers.filter((d) => !holders.some((h) => h.id === d.id))

  return (
    <TmsScrollPage
      title={<Link to={`/profiles/assets?tab=${tabParam}`} className="pf-link"><ArrowLeft size={13} /> Assets</Link>}
      width="full"
      data-testid="asset-profile"
    >
      <TmsProfileHeader
        as="h1"
        name={assetTitle(equip)}
        chips={(
          <>
            <TmsBadge tone={equip.active ? 'green' : 'gray'}>{equip.active ? 'Active' : 'Inactive'}</TmsBadge>
            <TmsBadge tone="blue">{assetNoun(equip.type)}</TmsBadge>
            {isTruck && equip.fleetGroup ? <TmsBadge tone="gray">{assetFleetLabel(equip.fleetGroup)}</TmsBadge> : null}
            <TmsBadge tone={docs.tone}>Docs: {docs.label}</TmsBadge>
          </>
        )}
        subtitle={(
          <span className="pf-head-meta">
            <span>{makeModel(equip) || 'No make / model yet'}</span>
            {equip.vin ? <span>VIN {formatVin(equip.vin)}</span> : null}
            {equip.plate ? <span>Plate {equip.plate}</span> : null}
            <span>{holders.length > 0 ? holders.map((d) => d.name).join(', ') : 'No driver'}</span>
          </span>
        )}
        actions={(
          <>
            <TmsButton onClick={openPark} data-testid="asset-park">{equip.active ? <><PauseCircle size={14} /> Mark inactive</> : <><PlayCircle size={14} /> Reactivate</>}</TmsButton>
            <TmsButton onClick={() => setEditing(true)} data-testid="asset-edit"><Pencil size={14} /> Edit details</TmsButton>
          </>
        )}
      />

      <div className="pf-tabs" style={{ marginTop: 16 }}>
        <TmsSegmentedTabs
          aria-label="Asset profile"
          active={tab}
          onSelect={setTab}
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'assignment', label: 'Assignment' },
            { key: 'documents', label: 'Documents', count: docs.missing + docs.attention || undefined },
            { key: 'maintenance', label: 'Maintenance', count: myTasks.filter((t) => t.status === 'upcoming').length || undefined },
          ]}
        />
      </div>

      {tab === 'overview' && (
        <div className="pf-body">
          <div className="pf-main">
            <ProfileSection title="Identity" action={<TmsButton size="sm" onClick={() => setEditing(true)}>Edit</TmsButton>}>
              <ProfileRows rows={[
                { label: 'Unit number', value: equip.unitNumber },
                { label: 'Nickname', value: equip.nickname ?? '' },
                { label: 'Make / model / year', value: makeModel(equip) },
                { label: 'VIN', value: formatVin(equip.vin) || '' },
                { label: 'Plate', value: equip.plate ?? '' },
                { label: 'Ownership', value: OWNERSHIP_LABEL[equip.ownership] ?? equip.ownership },
                ...(isTruck ? [{ label: 'Fleet', value: assetFleetLabel(equip.fleetGroup) }] : []),
                { label: 'Mileage', value: equip.mileage != null ? `${equip.mileage.toLocaleString()} mi` : '' },
                { label: 'Fleet manager', value: equip.fleetManagerAssignee ? equip.fleetManagerAssignee.charAt(0).toUpperCase() + equip.fleetManagerAssignee.slice(1) : '' },
                { label: 'Tollway account', value: equip.onTollwayAccount ? 'Yes' : 'No' },
              ]} />
            </ProfileSection>
            <ProfileSection title="Compliance dates" action={<TmsButton size="sm" onClick={() => setEditing(true)}>Edit</TmsButton>}>
              <ProfileRows rows={[
                { label: 'DOT inspection', value: dates.dot ?? '' },
                { label: 'Insurance expires', value: dates.ins ?? '' },
                ...(isTruck ? [
                  { label: 'IFTA expires', value: dates.ifta ?? '' },
                  { label: 'IRP expires', value: dates.irp ?? '' },
                ] : []),
                { label: 'Bobtail insurance', value: dates.bobtail ?? '' },
                { label: 'Insured', value: equip.insured ? 'Yes' : 'No' },
              ]} />
            </ProfileSection>
            <ProfileSection title="Notes"><div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{equip.notes?.trim() || <span className="tms-muted">No notes.</span>}</div></ProfileSection>
          </div>
          {isTruck ? (
            <div className="pf-side">
              <ProfileSection title="Tracking & phone">
                <ProfileRows rows={[
                  { label: 'ELD', value: equip.eldSource === 'manual' ? `Own ELD${equip.eldSerialNumber ? ` · ${equip.eldSerialNumber}` : ''}` : equip.eldSource === 'blueink' ? 'BlueInk' : 'Motive' },
                  { label: 'Motive vehicle #', value: equip.motiveVehicleNumber ?? '' },
                  { label: 'Fuel cards', value: (equip.fuelCardNumbers ?? []).join(', ') },
                  { label: 'Share Live Location link', value: equip.trackingUrl ?? '' },
                ]} />
                <div className="pf-row" style={{ marginTop: 6 }}>
                  <div className="pf-row-main">
                    <div className="pf-row-sub">Work phone (rides in the truck)</div>
                    {editPhone ? (
                      <TruckPhoneEditor truckId={equip.id} unitNumber={equip.unitNumber} phone={config?.phone} phoneLabel={config?.phoneLabel} onDone={() => setEditPhone(false)} />
                    ) : (
                      <button type="button" className="pf-link" onClick={() => setEditPhone(true)} data-testid="asset-phone">
                        {config?.phone ? `${formatPhone(config.phone)}${config.phoneLabel ? ` · ${config.phoneLabel}` : ''}` : '+ Add phone'}
                      </button>
                    )}
                  </div>
                </div>
              </ProfileSection>
              <ProfileSection title="Preventive maintenance">
                <ProfileRows rows={[
                  { label: 'Last PM date', value: equip.lastPmDate ?? '' },
                  { label: 'Last PM mileage', value: equip.lastPmMileage != null ? `${equip.lastPmMileage.toLocaleString()} mi` : '' },
                  { label: 'Next PM due at', value: nextPm != null ? `${nextPm.toLocaleString()} mi` : '' },
                ]} />
              </ProfileSection>
            </div>
          ) : null}
        </div>
      )}

      {tab === 'assignment' && (
        <div className="pf-body">
          <div className="pf-main">
            {isTruck ? (
              <ProfileSection title="Driver & trailer">
                <div className="pf-form-grid">
                  <TmsField label="Driver" hint="Choosing a driver who has another truck moves them to this one.">
                    <TmsSelect
                      value={driver?.id ?? ''}
                      onChange={(e) => void assignDriver(e.target.value)}
                      options={availableDrivers.map((d) => ({ value: d.id, label: `${d.name}${d.assignedTruckId && d.assignedTruckId !== equip.id ? ' (has a truck)' : ''}` }))}
                      placeholder="No driver"
                    />
                  </TmsField>
                  <TmsField label="Trailer they pull" hint={driver ? undefined : 'Pick a driver first: a trailer is paired with the driver.'}>
                    <TmsSelect
                      value={driver?.assignedTrailerId ?? ''}
                      disabled={!driver}
                      onChange={(e) => driver && void setTrailerFor(driver.id, e.target.value || null)}
                      options={activeUnits(equipment, 'trailer').map((t) => ({ value: t.id, label: `Trailer ${t.unitNumber}` }))}
                      placeholder={driver?.bobtail ? 'Bobtail (no trailer)' : 'No trailer set'}
                    />
                  </TmsField>
                </div>
                <div className="pf-row-sub" style={{ marginTop: 8 }}>Assignments are kept on the driver and the truck together, so Fuel, Files and Dispatch all agree. The system does not keep an assignment history.</div>
              </ProfileSection>
            ) : (
              <ProfileSection title="Who pulls this trailer">
                {holders.length === 0 ? <div className="pf-empty">No driver is pulling this trailer.</div> : (
                  <div className="pf-rows">
                    {holders.map((d) => (
                      <div className="pf-row" key={d.id}>
                        <div className="pf-row-main">
                          <div className="pf-row-title"><Link className="pf-link" to={`/profiles/drivers/${d.id}`}>{d.name}</Link></div>
                          <div className="pf-row-sub">{d.assignedTruckId ? `Truck ${equipment.find((e) => e.id === d.assignedTruckId)?.unitNumber ?? ''}` : 'No truck'}</div>
                        </div>
                        <TmsButton size="sm" onClick={() => void setTrailerFor(d.id, null)}>Release</TmsButton>
                      </div>
                    ))}
                  </div>
                )}
                <div className="pf-form-grid" style={{ marginTop: 12 }}>
                  <TmsField label="Assign to a driver" hint="Replaces whatever trailer that driver pulls now.">
                    <TmsSelect
                      value=""
                      onChange={(e) => e.target.value && void setTrailerFor(e.target.value, equip.id)}
                      options={driversWithTrailers.map((d) => ({ value: d.id, label: d.name }))}
                      placeholder="Choose a driver"
                    />
                  </TmsField>
                </div>
              </ProfileSection>
            )}
          </div>
          <div className="pf-side">
            {isTruck && driver ? (
              <ProfileSection title={driver.name} action={<Link className="pf-link" to={`/profiles/drivers/${driver.id}`}>Open profile</Link>}>
                <ProfileRows rows={[
                  { label: 'Phone', value: driver.phone },
                  { label: 'Dispatcher', value: driver.dispatcherPrimary ?? '' },
                ]} />
              </ProfileSection>
            ) : null}
            {isTruck ? null : (
              <ProfileSection title="Trucks available">
                <div className="pf-row-sub">{trucks.length} active trucks. Pair a trailer by choosing the driver above.</div>
              </ProfileSection>
            )}
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <ProfileSection title={`Required documents · ${assetNoun(equip.type)}${isTruck && equip.fleetGroup ? ` · ${assetFleetLabel(equip.fleetGroup)}` : ''}`} testId="asset-documents">
          <ProfileDocuments
            entityType="TRUCK"
            entityId={equip.id}
            slots={slots}
            hub={hub}
            stateOf={assetSlotState(equip, hub.docFor)}
            uploadedBy={user?.email ?? null}
            needsExpiration={slotAsksExpiry}
          />
          <div className="pf-row-sub" style={{ marginTop: 8 }}>The DOT inspection date is kept on the record (Edit details), not on the document.</div>
        </ProfileSection>
      )}

      {tab === 'maintenance' && (
        <div className="pf-body">
          <div className="pf-main">
            <ProfileSection title="Tasks" action={<Link className="pf-link" to="/maintenance">Open Maintenance</Link>}>
              {myTasks.length === 0 ? <div className="pf-empty">No maintenance tasks for this {assetNoun(equip.type).toLowerCase()}.</div> : (
                <div className="pf-rows">
                  {[...myTasks].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).map((t) => (
                    <div className="pf-row" key={t.id}>
                      <div className="pf-row-main"><div className="pf-row-title">{t.title}</div><div className="pf-row-sub">{t.dueDate ? `Due ${t.dueDate}` : 'No due date'} · {t.priority}</div></div>
                      <TmsBadge tone={t.status === 'complete' ? 'green' : 'orange'}>{t.status === 'complete' ? 'Done' : 'Open'}</TmsBadge>
                    </div>
                  ))}
                </div>
              )}
            </ProfileSection>
            <ProfileSection title={`Invoices${myInvoices.length ? ` · ${money(myInvoices.reduce((s, i) => s + i.amount, 0))}` : ''}`} action={<Link className="pf-link" to="/trucks">Add on the Trucks page</Link>}>
              {myInvoices.length === 0 ? <div className="pf-empty">No maintenance invoices.</div> : (
                <div className="pf-rows">
                  {myInvoices.slice(0, 15).map((i) => (
                    <div className="pf-row" key={i.id}>
                      <div className="pf-row-main"><div className="pf-row-title">{i.vendor || 'Unknown vendor'}</div><div className="pf-row-sub">{[i.date, i.description].filter(Boolean).join(' · ')}</div></div>
                      <span className="pf-row-title">{money(i.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </ProfileSection>
          </div>
        </div>
      )}

      {editing ? (
        <EquipmentForm
          initial={equip}
          initialCosts={readTruckCosts(equip.id, expenseData.recurring, expenseData.allocations, expenseData.expenseTypes).inputs}
          onSave={(data, costs) => { saveEquipment({ existing: equip, data, costs, addEquipment, updateEquipment, expenseData }); setEditing(false) }}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {parking ? (
        <MarkInactiveDialog
          truck={equip}
          insuranceAnnual={premium}
          expenses={{ recurring: expenseData.recurring, allocations: expenseData.allocations, expenseTypes: expenseData.expenseTypes }}
          heldBy={equip.type === 'trailer' ? driversHoldingTrailer(equip.id, drivers) : []}
          onUnassign={(driverId) => { void updateDriver(driverId, { assignedTrailerId: null }) }}
          onDone={(patch) => { updateEquipment(equip.id, patch); expenseData.refresh(); setParking(false) }}
          onClose={() => setParking(false)}
        />
      ) : null}
    </TmsScrollPage>
  )
}
