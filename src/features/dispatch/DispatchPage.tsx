import { TruckAssignSelect } from '@/components/TruckAssignSelect'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Archive, ArchiveRestore, MessageSquarePlus, RefreshCw, Search, Settings, UserPlus, UserCheck, Loader2, AlertTriangle, Phone, MessageSquare, Hash, ExternalLink, Send, SlidersHorizontal, PanelRightClose, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDispatch } from '@/hooks/useDispatch'
import { useDrivers } from '@/hooks/useDrivers'
import { useLoads } from '@/hooks/useLoads'
import { useAppStore } from '@/store/useAppStore'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import { whereaboutsOf, whereaboutsLine, statusLine, unitLine } from './driverWhereabouts'
import { cn } from '@/lib/utils'
import { conversationTitle, prettyPhone, sortConversations, conversationMatches, dispatchersOf, type DispatchConversation } from '@/lib/dispatch'
import { ConversationList } from './ConversationList'
import { Thread } from './Thread'
import { NewMessageDialog, LinkNumberDialog, DispatchSettingsDialog, SlackChannelWizard, AssignDialog, FileAsPodDialog } from './DispatchDialogs'
import { driverIsOnLoad, laneLabel } from '@/lib/driverJourney'
import { getStops } from '@/lib/stops'
import { markAllStopsDone } from '@/lib/stopEvents'
import { staffUploadDriverDoc } from '@/lib/driverSubmissionsClient'
import type { DispatchMedia } from '@/lib/dispatch'
import type { Load } from '@/types'
import { staffName } from './dispatchUi'
import { FilterDialog } from './FilterDialog'
import { applyFilters, readFilters, writeFilters, filterCount, type DispatchFilters } from './dispatchFilters'
import { conversationColor, initialsOf } from './conversationColor'
import { DriverSchedulePanel } from './DriverSchedulePanel'
import { unitTypeOf, unitKindLabel, unitTypeEditable, nextUnitType, UNIT_TYPE_LABEL } from '@/lib/unitType'
import { useLoadPaperwork } from '@/hooks/useLoadPaperwork'
import { loadHasPod } from '@/lib/podPresence'
import { chicagoDateStr } from '@/lib/date'
import { weekStartOfISO } from '@/features/driver-pay/week'

type Tab = 'OPEN' | 'UNREAD' | 'MINE' | 'ARCHIVED'
const TABS: { key: Tab; label: string }[] = [
  { key: 'OPEN', label: 'Open' },
  { key: 'UNREAD', label: 'Unread' },
  { key: 'MINE', label: 'Mine' },
  { key: 'ARCHIVED', label: 'Archived' },
]

/**
 * @param compact The always-on drawer beside every other page: one column (list, then
 *   the thread with a Back button), a slim top bar, no settings. Same data and actions.
 */
export function DispatchPage({ compact = false, onHide }: { compact?: boolean; onHide?: () => void } = {}) {
  const { user, isAdmin, isOwner } = useAuth()
  const isMobile = useIsMobile()
  // One-column behaviour for phones and for the drawer alike.
  const narrow = isMobile || compact
  const { drivers, updateDriver } = useDrivers()
  const d = useDispatch()
  const [tab, setTab] = useState<Tab>('OPEN')
  const [query, setQuery] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [linking, setLinking] = useState<DispatchConversation | null>(null)
  const [slackWizard, setSlackWizard] = useState<DispatchConversation | null>(null)
  const [assigning, setAssigning] = useState<DispatchConversation | null>(null)
  const [defaultInvites, setDefaultInvites] = useState<string[] | null>(null)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])
  // Where each truck is, for the location line under a driver: refreshed every minute.
  // The live working set: a voided load is not dispatchable work, so it gives no driver a
  // location line and shows up in no POD-filing picker here.
  const { loads, updateLoad } = useLoads()
  /** An inbound attachment being filed as a POD, while the load picker is open. */
  const [filingPod, setFilingPod] = useState<DispatchMedia | null>(null)
  const equipment = useAppStore((s) => s.equipment)
  // Which loads have a POD on file: for owner operators that is what "delivered" means.
  const paperwork = useLoadPaperwork(loads)
  const hasPod = (load: (typeof loads)[number]) => (paperwork.index ? loadHasPod(paperwork.index, load) : false)

  const [locations, setLocations] = useState<TruckLocation[]>([])
  useEffect(() => {
    let alive = true
    const tick = () => { if (document.visibilityState === 'visible') listTruckLocations().then((rows) => { if (alive) setLocations(rows) }).catch(() => undefined) }
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 60_000)
    return () => { alive = false; clearTimeout(first); clearInterval(t) }
  }, [])
  const subline = (c: DispatchConversation): string | null => {
    const driver = c.driverId ? drivers.find((x) => x.id === c.driverId) : null
    return whereaboutsLine(whereaboutsOf(driver, loads, equipment, locations, now.getTime()))
  }
  // The truck's last fix for a driver, for the route strip.
  const truckFixOf = (driver: typeof drivers[number]) => {
    const eq = driver.assignedTruckId ? equipment.find((e) => e.id === driver.assignedTruckId) : undefined
    const loc = eq ? locations.filter((l) => l.truckId === eq.id || l.unitNumber === String(eq.unitNumber)).sort((a, b) => (a.locatedAt < b.locatedAt ? 1 : -1))[0] : undefined
    return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? { lat: loc.lat, lng: loc.lon } : null
  }
  // The driver's last app status (on site, departed, delivered, POD), shown on every row.
  const statusOf = (c: DispatchConversation): string | null => {
    const driver = c.driverId ? drivers.find((x) => x.id === c.driverId) : null
    return statusLine(c, whereaboutsOf(driver, loads, equipment, locations, now.getTime()))
  }

  const me = user?.email?.toLowerCase() ?? ''
  // This person's own filter (driver types, drivers), remembered per user on this device.
  const [filters, setFilters] = useState<DispatchFilters>(() => readFilters(user?.email ?? ''))
  const [filterOpen, setFilterOpen] = useState(false)
  const applyFilterChoice = (next: DispatchFilters) => { setFilters(next); writeFilters(user?.email ?? '', next) }
  // Assigning, relinking a number and the settings are admin-only; the Lambda enforces it too.
  const canManage = isAdmin || isOwner
  const counts = useMemo(() => ({
    OPEN: d.conversations.filter((c) => c.status !== 'ARCHIVED').length,
    UNREAD: d.conversations.filter((c) => c.status !== 'ARCHIVED' && (c.unreadCount ?? 0) > 0).length,
    MINE: d.conversations.filter((c) => c.status !== 'ARCHIVED' && (c.assignedTo === me || c.assignedBackup === me)).length,
    ARCHIVED: d.conversations.filter((c) => c.status === 'ARCHIVED').length,
  }), [d.conversations, me])

  const rows = useMemo(() => sortConversations(applyFilters(d.conversations, drivers, filters).filter((c) => {
    if (tab === 'ARCHIVED') return c.status === 'ARCHIVED'
    if (c.status === 'ARCHIVED') return false
    if (tab === 'UNREAD') return (c.unreadCount ?? 0) > 0
    if (tab === 'MINE') return c.assignedTo === me || c.assignedBackup === me
    return true
  }).filter((c) => conversationMatches(c, query))), [d.conversations, drivers, filters, tab, me, query])

  const selected = d.conversations.find((c) => c.id === d.selectedId) ?? null
  const selectedDriver = selected?.driverId ? drivers.find((x) => x.id === selected.driverId) ?? null : null

  /*
   * The office's record that an owner operator delivered. They do not tap stops, so until
   * the POD arrives nothing else moves the shipment off "under way"; this stamps the stops
   * and leaves a note in the thread. The POD is still owed — the loads board keeps saying so.
   */
  const markDelivered = async (load: Load) => {
    const pro = load.aljexId?.trim() || load.id.slice(0, 8)
    if (!window.confirm(`Mark PRO ${pro} delivered?\n\nThis records the delivery for dispatch. The driver still owes the POD.`)) return
    try {
      await updateLoad(load.id, { stops: markAllStopsDone(getStops(load), new Date().toISOString()) })
      if (selected) await d.addNote(selected.id, `Marked PRO ${pro} delivered — POD still owed`).catch(() => undefined)
      toast.success(`PRO ${pro} marked delivered`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark the load delivered')
    }
  }

  /** A POD texted in, filed on the load exactly as a staff upload from the load drawer. */
  const fileAsPod = async (media: DispatchMedia, loadId: string) => {
    if (!selectedDriver) return
    const load = loads.find((l) => l.id === loadId)
    const url = await d.mediaUrl(media.key)
    const res = await fetch(url)
    if (!res.ok) throw new Error('Could not read the attachment')
    const blob = await res.blob()
    const ext = media.contentType === 'application/pdf' ? 'pdf' : (media.contentType.split('/')[1] || 'jpg')
    const file = new File([blob], media.name ?? `pod-${load?.aljexId?.trim() || loadId.slice(0, 8)}.${ext}`, { type: media.contentType })
    await staffUploadDriverDoc({
      driver: { id: selectedDriver.id, name: selectedDriver.name, email: selectedDriver.email ?? null },
      kind: 'POD', files: [file], submittedByEmail: me,
      referenceNumber: load?.aljexId?.trim() || undefined, loadId,
      note: 'Texted to dispatch',
    })
    paperwork.refresh()
    if (selected) await d.addNote(selected.id, `Filed the attachment as the POD for PRO ${load?.aljexId?.trim() || '—'}`).catch(() => undefined)
    toast.success(`POD filed on PRO ${load?.aljexId?.trim() || '—'}`)
  }
  const selectedColor = selected ? conversationColor(selected, drivers) : null
  const selectedDispatchers = dispatchersOf(selectedDriver)
  const selectedWhereabouts = selected ? whereaboutsOf(selectedDriver, loads, equipment, locations, now.getTime()) : null
  const selectedWhere = whereaboutsLine(selectedWhereabouts)
  const selectedUnits = unitLine(selectedWhereabouts)
  const selectedStatus = selected ? statusLine(selected, whereaboutsOf(selectedDriver, loads, equipment, locations, now.getTime())) : null

  // Opening a conversation with unread messages marks it read for the whole team.
  useEffect(() => {
    if (selected && (selected.unreadCount ?? 0) > 0) d.markRead(selected.id).catch(() => { /* next poll will retry */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.unreadCount])

  // The wizard pre-fills the default invitees from settings; fetched once, on first use.
  const openSlackWizard = async (c: DispatchConversation) => {
    if (defaultInvites === null) {
      try {
        const s = await d.getSettings()
        setDefaultInvites(s?.slackInviteEmails ?? (me ? [me] : []))
      } catch {
        setDefaultInvites(me ? [me] : [])
      }
    }
    setSlackWizard(c)
  }
  // The wizard's invite list: the settings defaults plus this driver's own dispatchers.
  const wizardInvites = (c: DispatchConversation): string[] => {
    const driver = c.driverId ? drivers.find((x) => x.id === c.driverId) : undefined
    return Array.from(new Set([...(defaultInvites ?? []), ...dispatchersOf(driver)]))
  }

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn() } catch (err) { toast.error(err instanceof Error ? err.message : `Could not ${label}`) }
  }

  const padX = isMobile ? 12 : 20
  const configured = d.status?.configured ?? true
  const showList = !narrow || !selected
  const showThread = !narrow || !!selected

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: `12px ${padX}px`, borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ds-t1)', letterSpacing: '-0.01em', margin: 0 }}>Dispatch</h1>
        <p style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 2 }}>
          {d.status?.dispatchNumber
            ? <>Drivers text and call <strong style={{ color: 'var(--ds-t2)' }}>{prettyPhone(d.status.dispatchNumber)}</strong>{d.status.ringing ? ` · calls ring ${d.status.ringing} phone${d.status.ringing === 1 ? '' : 's'}` : ' · calls go to voicemail'}</>
            : 'One number the whole team texts and calls drivers from.'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setNewOpen(true)}><MessageSquarePlus className="size-3.5" />{isMobile ? '' : 'New message'}</Button>
        {(isAdmin || isOwner) ? <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setSettingsOpen(true)} title="Call routing, voicemail, Slack"><Settings className="size-3.5" />{isMobile ? '' : 'Settings'}</Button> : null}
        <Button variant="outline" size="sm" className="h-8" onClick={() => void d.refresh()} disabled={d.loading} title="Refresh"><RefreshCw className={cn('size-3.5', d.loading && 'animate-spin')} /></Button>
      </div>
    </div>
  )

  const banner = !configured ? (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: `8px ${padX}px`, background: 'var(--ds-amber-bg)', color: 'var(--ds-t1)', fontSize: 13, borderBottom: '1px solid var(--ds-border)' }}>
      <AlertTriangle className="size-4" style={{ color: 'var(--ds-amber)' }} />
      Twilio is not connected yet, so texts cannot be sent. Ask Ryne to run the Dispatch setup (scripts/dispatchTwilioSetup.mjs).
    </div>
  ) : null

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, width: narrow ? '100%' : 340, borderRight: narrow ? 'none' : '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--ds-border-soft)', display: 'grid', gap: 8 }}>
        <div style={{ position: 'relative' }}>
          <Search className="size-3.5" style={{ position: 'absolute', left: 10, top: 10, color: 'var(--ds-t3)' }} />
          <Input id="dispatch-search" placeholder="Search name, number, text" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-8" />
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', background: tab === t.key ? 'var(--ds-bg-3)' : 'transparent', color: tab === t.key ? 'var(--ds-t1)' : 'var(--ds-t3)', fontWeight: tab === t.key ? 600 : 500 }}>
              {t.label}{counts[t.key] ? <span style={{ marginLeft: 4, fontVariantNumeric: 'tabular-nums', color: t.key === 'UNREAD' && counts.UNREAD ? 'var(--ds-blue)' : undefined }}>{counts[t.key]}</span> : null}
            </button>
          ))}
          <button type="button" onClick={() => setFilterOpen(true)} title="Filter by driver type or driver"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--ds-border)', cursor: 'pointer', background: filterCount(filters) ? 'var(--ds-blue-bg)' : 'transparent', color: filterCount(filters) ? 'var(--ds-blue)' : 'var(--ds-t3)', fontWeight: 600 }}>
            <SlidersHorizontal className="size-3.5" /> Filter{filterCount(filters) ? ` · ${filterCount(filters)}` : ''}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {d.loading && d.conversations.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32, color: 'var(--ds-t3)' }}><Loader2 className="size-5 animate-spin" /></div>
        ) : d.error && d.conversations.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--ds-red)' }}>{d.error}</div>
        ) : (
          <ConversationList rows={rows} selectedId={d.selectedId} onSelect={d.select} now={now} subline={subline} statusOf={statusOf} />
        )}
      </div>
    </div>
  )

  const thread = selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: 'var(--ds-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--ds-border)', borderTop: `3px solid ${selectedColor?.border ?? 'transparent'}`, background: 'var(--ds-surface)', flexWrap: narrow ? 'wrap' : 'nowrap' }}>
        {narrow ? <Button variant="ghost" size="icon" className="size-8" aria-label="Back to conversations" onClick={() => d.select(null)}><ArrowLeft className="size-4" /></Button> : null}
        <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 18, background: selectedColor?.avatarBg, color: '#fff', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{initialsOf(conversationTitle(selected))}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: selectedColor?.text ?? 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversationTitle(selected)}</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--ds-t2)' }}>{prettyPhone(selected.phone)}</span>
            <a href={`tel:${selected.phone}`} title="Call from your phone" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ds-blue)', fontWeight: 600 }}><Phone className="size-3" />Call</a>
            <a href={`sms:${selected.phone}`} title="Text from your own phone (not the dispatch number)" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ds-blue)', fontWeight: 600 }}><MessageSquare className="size-3" />Text</a>
            {selectedDriver ? <span>{selectedDriver.fleetGroup === 'AMAZON' ? 'Owner operator' : selectedDriver.fleetGroup === 'BOX_TRUCK' ? 'Box truck' : selectedDriver.fleetGroup === 'LOCAL' ? 'Ivan local' : 'Driver'}{selectedDriver.active ? '' : ' · inactive'}</span> : <span>Not a driver on file</span>}
            {selectedDriver ? (
              unitTypeEditable(selectedDriver) ? (
                <button type="button" onClick={() => { const next = nextUnitType(selectedDriver.unitType); void updateDriver(selectedDriver.id, { unitType: next }); toast.success(`${selectedDriver.name}: ${UNIT_TYPE_LABEL[next]}`) }}
                  title="Tap to change: dry van → flatbed → power only"
                  style={{ all: 'unset', cursor: 'pointer', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: unitTypeOf(selectedDriver) ? 'var(--ds-t1)' : 'var(--ds-amber)', background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border)', borderRadius: 4, padding: '1px 6px' }}>
                  {unitKindLabel(unitTypeOf(selectedDriver))} ⇄
                </button>
              ) : <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ds-t2)', background: 'var(--ds-bg-2)', borderRadius: 4, padding: '1px 6px' }}>{unitKindLabel(unitTypeOf(selectedDriver))}</span>
            ) : null}
            {selectedStatus ? <span style={{ color: 'var(--ds-t2)', fontWeight: 600 }}>Last status: {selectedStatus}</span> : null}
            {selectedUnits ? <span title="The truck on their file and the trailer on the load they are hauling" style={{ color: 'var(--ds-t2)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>🚛 {selectedUnits}</span> : null}
            {/* Staff can move the driver to the right truck from here when they picked the wrong one. */}
            {selectedDriver && selectedDriver.fleetGroup !== 'AMAZON' ? <TruckAssignSelect driverId={selectedDriver.id} label="Truck" compact /> : null}
            {selectedWhere ? <span style={{ color: 'var(--ds-green)', fontWeight: 600 }}>📍 {selectedWhere}</span> : null}
            {(() => {
              const primary = selected.assignedTo || selectedDispatchers[0] || null
              const backup = selected.assignedBackup || selectedDispatchers[1] || null
              if (!primary && !backup) return <span>· No dispatcher yet</span>
              return <span title={[primary, backup].filter(Boolean).join(', ')}>· Dispatcher {primary ? (primary === me ? 'you' : staffName(primary)) : 'nobody'}{backup ? ` · backup ${backup === me ? 'you' : staffName(backup)}` : ''}</span>
            })()}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', ...(narrow ? { width: '100%', paddingLeft: 46 } : {}) }}>
          {configured ? <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Text them who we are, the number to save, and a contact card" onClick={() => void act('send the intro', () => d.sendIntro(selected.id))}>
            <Send className="size-3.5" />{narrow ? '' : 'Intro'}
          </Button> : null}
          {canManage ? <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Primary and backup dispatcher" onClick={() => setAssigning(selected)}>
            <UserCheck className="size-3.5" />{narrow ? '' : (selected.assignedTo ? staffName(selected.assignedTo) : 'Assign')}
          </Button> : null}
          {canManage ? <Button variant="outline" size="sm" className="h-8 gap-1.5" title={selected.driverId ? 'Change who this number belongs to' : 'Link this number to a driver'} onClick={() => setLinking(selected)}>
            <UserPlus className="size-3.5" />{narrow ? '' : (selected.driverId ? 'Relink' : 'Link driver')}
          </Button> : null}
          {d.status?.slackBridge ? (selected.slackChannelId ? (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" asChild title={`#${selected.slackChannelName ?? 'channel'} in Slack`}>
              <a href={`https://bcatcorp.slack.com/archives/${selected.slackChannelId}`} target="_blank" rel="noreferrer"><Hash className="size-3.5" />{narrow ? '' : (selected.slackChannelName ?? 'Slack')}<ExternalLink className="size-3" /></a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Create this driver's Slack channel" onClick={() => void openSlackWizard(selected)}>
              <Hash className="size-3.5" />{narrow ? '' : 'Create Slack channel'}
            </Button>
          )) : null}
          <Button variant="outline" size="sm" className="h-8" title={selected.status === 'ARCHIVED' ? 'Reopen' : 'Archive'} onClick={() => void act('archive', () => d.setArchived(selected.id, selected.status !== 'ARCHIVED'))}>
            {selected.status === 'ARCHIVED' ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </Button>
          {canManage ? (
            <Button variant="outline" size="sm" className="h-8 text-red-600" title="Delete this conversation and every message in it (admins only)"
              onClick={() => {
                if (!window.confirm(`Delete the conversation with ${conversationTitle(selected)}?\n\nEvery text, note and status in it is removed for good. The driver's Slack channel, if any, is left for you to archive in Slack.`)) return
                void act('delete the conversation', () => d.remove(selected.id))
              }}>
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {/* Any conversation without a channel gets the prompt: started by the driver or by us. */}
      {d.status?.slackBridge && !selected.slackChannelId ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: 'var(--ds-blue-bg)', borderBottom: '1px solid var(--ds-border)', fontSize: 13 }}>
          <Hash className="size-4" style={{ color: 'var(--ds-blue)' }} />
          <span style={{ flex: 1 }}>{conversationTitle(selected)} has no Slack channel yet. Create one so the team can answer from Slack.</span>
          <Button size="sm" className="h-7" onClick={() => void openSlackWizard(selected)}>Set up channel</Button>
        </div>
      ) : null}
      {selectedDriver ? <DriverSchedulePanel driver={selectedDriver} loads={loads} today={chicagoDateStr(now)} weekStart={weekStartOfISO(chicagoDateStr(now))} truck={truckFixOf(selectedDriver)} now={now.getTime()} hasPod={hasPod} onMarkDelivered={(load) => void markDelivered(load)} messages={d.thread} /> : null}
      {filingPod && selectedDriver ? (
        <FileAsPodDialog
          driverName={selectedDriver.name}
          attachment={filingPod}
          loads={driverLoadChoices(loads as Load[], selectedDriver.id, hasPod)}
          onClose={() => setFilingPod(null)}
          onPick={(loadId) => fileAsPod(filingPod, loadId)}
        />
      ) : null}
      <Thread
        key={selected.id}
        conversation={selected}
        messages={d.thread}
        loading={d.threadLoading}
        now={now}
        canSend={configured}
        me={me}
        accent={selectedColor ? { border: selectedColor.border, bg: selectedColor.bg } : undefined}
        getUrl={d.mediaUrl}
        onSend={(body, files) => d.send({ conversationId: selected.id, body, files })}
        onNote={(body) => d.addNote(selected.id, body)}
        onIntro={() => d.sendIntro(selected.id)}
        onFileAsPod={selectedDriver ? (media) => setFilingPod(media) : undefined}
      />
    </div>
  ) : (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ds-t3)', fontSize: 13, background: 'var(--ds-bg)' }}>
      Pick a conversation, or start a new message.
    </div>
  )

  const compactBar = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <MessageSquare className="size-4" style={{ color: 'var(--ds-blue)' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ds-t1)' }}>Dispatch</span>
        {counts.UNREAD ? <span style={{ minWidth: 18, height: 18, borderRadius: 9, background: 'var(--ds-blue)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{counts.UNREAD}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setNewOpen(true)} title="New message"><MessageSquarePlus className="size-3.5" /></Button>
        <Button size="sm" variant="outline" className="h-7 gap-1" asChild title="Open the full Dispatch page"><Link to="/dispatch"><ExternalLink className="size-3.5" /></Link></Button>
        {onHide ? <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={onHide} title="Hide the dispatch drawer"><PanelRightClose className="size-3.5" /></Button> : null}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {compact ? compactBar : header}
      {banner}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {showList ? list : null}
        {showThread ? thread : null}
      </div>
      {newOpen ? <NewMessageDialog onClose={() => setNewOpen(false)} onStart={async (input) => {
        const c = await d.start(input)
        setTab(c.status === 'ARCHIVED' ? 'ARCHIVED' : 'OPEN')
        d.select(c.id)
        // Same as a driver texting in: the channel wizard comes up straight away.
        if (d.status?.slackBridge && !c.slackChannelId) void openSlackWizard(c)
        return c
      }} /> : null}
      {linking ? <LinkNumberDialog key={linking.id} conversation={linking} onClose={() => setLinking(null)} onLink={(input) => d.link(linking.id, input)} /> : null}
      {slackWizard ? <SlackChannelWizard key={slackWizard.id} conversation={slackWizard} defaultInvites={wizardInvites(slackWizard)} onClose={() => setSlackWizard(null)} onCreate={(input) => d.createSlackChannel(slackWizard.id, input)} /> : null}
      {assigning ? <AssignDialog key={assigning.id} conversation={assigning} fromDriver={dispatchersOf(assigning.driverId ? drivers.find((x) => x.id === assigning.driverId) : null)} loadStaff={d.listStaff} onClose={() => setAssigning(null)} onSave={(p, b) => d.assign(assigning.id, p, b)} /> : null}
      {filterOpen ? <FilterDialog value={filters} conversations={d.conversations} onClose={() => setFilterOpen(false)} onApply={applyFilterChoice} /> : null}
      {settingsOpen ? <DispatchSettingsDialog onClose={() => setSettingsOpen(false)} dispatchNumber={d.status?.dispatchNumber ?? null} load={d.getSettings} save={d.saveSettings} /> : null}
    </div>
  )
}

/** The driver's loads for the POD picker: under way first, then newest; delivered ones last and greyed. */
function driverLoadChoices(loads: Load[], driverId: string, hasPod: (load: Load) => boolean) {
  const latestAppt = (l: Load) => getStops(l).map((s) => s.appt ?? '').sort().pop() ?? ''
  return loads
    .filter((l) => driverIsOnLoad(l, driverId))
    .map((l) => ({ id: l.id, pro: l.aljexId?.trim() || '—', lane: laneLabel(l), when: latestAppt(l) ? latestAppt(l).slice(0, 10) : null, delivered: hasPod(l), raw: latestAppt(l) }))
    .sort((a, b) => Number(a.delivered) - Number(b.delivered) || b.raw.localeCompare(a.raw))
    .slice(0, 12)
}
