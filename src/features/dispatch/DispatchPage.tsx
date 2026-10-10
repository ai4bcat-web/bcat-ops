import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Archive, ArchiveRestore, MessageSquarePlus, RefreshCw, Search, Settings, UserPlus, UserCheck, Loader2, AlertTriangle, Phone, MessageSquare, Hash, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDispatch } from '@/hooks/useDispatch'
import { useDrivers } from '@/hooks/useDrivers'
import { useAppStore } from '@/store/useAppStore'
import { listTruckLocations, type TruckLocation } from '@/lib/apiClient'
import { whereaboutsOf, whereaboutsLine } from './driverWhereabouts'
import { cn } from '@/lib/utils'
import { conversationTitle, prettyPhone, sortConversations, conversationMatches, dispatchersOf, type DispatchConversation } from '@/lib/dispatch'
import { ConversationList } from './ConversationList'
import { Thread } from './Thread'
import { NewMessageDialog, LinkNumberDialog, DispatchSettingsDialog, SlackChannelWizard, AssignDialog } from './DispatchDialogs'
import { staffName } from './dispatchUi'
import { conversationColor, initialsOf } from './conversationColor'

type Tab = 'OPEN' | 'UNREAD' | 'MINE' | 'ARCHIVED'
const TABS: { key: Tab; label: string }[] = [
  { key: 'OPEN', label: 'Open' },
  { key: 'UNREAD', label: 'Unread' },
  { key: 'MINE', label: 'Mine' },
  { key: 'ARCHIVED', label: 'Archived' },
]

export function DispatchPage() {
  const { user, isAdmin, isOwner } = useAuth()
  const isMobile = useIsMobile()
  const { drivers } = useDrivers()
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
  const loads = useAppStore((s) => s.loads)
  const equipment = useAppStore((s) => s.equipment)
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

  const me = user?.email?.toLowerCase() ?? ''
  // Assigning, relinking a number and the settings are admin-only; the Lambda enforces it too.
  const canManage = isAdmin || isOwner
  const counts = useMemo(() => ({
    OPEN: d.conversations.filter((c) => c.status !== 'ARCHIVED').length,
    UNREAD: d.conversations.filter((c) => c.status !== 'ARCHIVED' && (c.unreadCount ?? 0) > 0).length,
    MINE: d.conversations.filter((c) => c.status !== 'ARCHIVED' && (c.assignedTo === me || c.assignedBackup === me)).length,
    ARCHIVED: d.conversations.filter((c) => c.status === 'ARCHIVED').length,
  }), [d.conversations, me])

  const rows = useMemo(() => sortConversations(d.conversations.filter((c) => {
    if (tab === 'ARCHIVED') return c.status === 'ARCHIVED'
    if (c.status === 'ARCHIVED') return false
    if (tab === 'UNREAD') return (c.unreadCount ?? 0) > 0
    if (tab === 'MINE') return c.assignedTo === me || c.assignedBackup === me
    return true
  }).filter((c) => conversationMatches(c, query))), [d.conversations, tab, me, query])

  const selected = d.conversations.find((c) => c.id === d.selectedId) ?? null
  const selectedDriver = selected?.driverId ? drivers.find((x) => x.id === selected.driverId) ?? null : null
  const selectedColor = selected ? conversationColor(selected, drivers) : null
  const selectedDispatchers = dispatchersOf(selectedDriver)
  const selectedWhere = selected ? whereaboutsLine(whereaboutsOf(selectedDriver, loads, equipment, locations, now.getTime())) : null

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
  const showList = !isMobile || !selected
  const showThread = !isMobile || !!selected

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
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, width: isMobile ? '100%' : 340, borderRight: isMobile ? 'none' : '1px solid var(--ds-border)', background: 'var(--ds-surface)', flexShrink: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--ds-border-soft)', display: 'grid', gap: 8 }}>
        <div style={{ position: 'relative' }}>
          <Search className="size-3.5" style={{ position: 'absolute', left: 10, top: 10, color: 'var(--ds-t3)' }} />
          <Input id="dispatch-search" placeholder="Search name, number, text" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-8" />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: 'none', cursor: 'pointer', background: tab === t.key ? 'var(--ds-bg-3)' : 'transparent', color: tab === t.key ? 'var(--ds-t1)' : 'var(--ds-t3)', fontWeight: tab === t.key ? 600 : 500 }}>
              {t.label}{counts[t.key] ? <span style={{ marginLeft: 4, fontVariantNumeric: 'tabular-nums', color: t.key === 'UNREAD' && counts.UNREAD ? 'var(--ds-blue)' : undefined }}>{counts[t.key]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {d.loading && d.conversations.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32, color: 'var(--ds-t3)' }}><Loader2 className="size-5 animate-spin" /></div>
        ) : d.error && d.conversations.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--ds-red)' }}>{d.error}</div>
        ) : (
          <ConversationList rows={rows} selectedId={d.selectedId} onSelect={d.select} now={now} subline={subline} />
        )}
      </div>
    </div>
  )

  const thread = selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: 'var(--ds-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--ds-border)', borderTop: `3px solid ${selectedColor?.border ?? 'transparent'}`, background: 'var(--ds-surface)' }}>
        {isMobile ? <Button variant="ghost" size="icon" className="size-8" aria-label="Back to conversations" onClick={() => d.select(null)}><ArrowLeft className="size-4" /></Button> : null}
        <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 18, background: selectedColor?.avatarBg, color: '#fff', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{initialsOf(conversationTitle(selected))}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: selectedColor?.text ?? 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversationTitle(selected)}</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--ds-t2)' }}>{prettyPhone(selected.phone)}</span>
            <a href={`tel:${selected.phone}`} title="Call from your phone" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ds-blue)', fontWeight: 600 }}><Phone className="size-3" />Call</a>
            <a href={`sms:${selected.phone}`} title="Text from your own phone (not the dispatch number)" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--ds-blue)', fontWeight: 600 }}><MessageSquare className="size-3" />Text</a>
            {selectedDriver ? <span>{selectedDriver.fleetGroup === 'AMAZON' ? 'Owner operator' : selectedDriver.fleetGroup === 'BOX_TRUCK' ? 'Box truck' : selectedDriver.fleetGroup === 'LOCAL' ? 'Ivan local' : 'Driver'}{selectedDriver.active ? '' : ' · inactive'}</span> : <span>Not a driver on file</span>}
            {selectedWhere ? <span style={{ color: 'var(--ds-green)', fontWeight: 600 }}>📍 {selectedWhere}</span> : null}
            {(() => {
              const primary = selected.assignedTo || selectedDispatchers[0] || null
              const backup = selected.assignedBackup || selectedDispatchers[1] || null
              if (!primary && !backup) return <span>· No dispatcher yet</span>
              return <span title={[primary, backup].filter(Boolean).join(', ')}>· Dispatcher {primary ? (primary === me ? 'you' : staffName(primary)) : 'nobody'}{backup ? ` · backup ${backup === me ? 'you' : staffName(backup)}` : ''}</span>
            })()}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {canManage ? <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Primary and backup dispatcher" onClick={() => setAssigning(selected)}>
            <UserCheck className="size-3.5" />{isMobile ? '' : (selected.assignedTo ? staffName(selected.assignedTo) : 'Assign')}
          </Button> : null}
          {canManage ? <Button variant="outline" size="sm" className="h-8 gap-1.5" title={selected.driverId ? 'Change who this number belongs to' : 'Link this number to a driver'} onClick={() => setLinking(selected)}>
            <UserPlus className="size-3.5" />{isMobile ? '' : (selected.driverId ? 'Relink' : 'Link driver')}
          </Button> : null}
          {d.status?.slackBridge ? (selected.slackChannelId ? (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" asChild title={`#${selected.slackChannelName ?? 'channel'} in Slack`}>
              <a href={`https://bcatcorp.slack.com/archives/${selected.slackChannelId}`} target="_blank" rel="noreferrer"><Hash className="size-3.5" />{isMobile ? '' : (selected.slackChannelName ?? 'Slack')}<ExternalLink className="size-3" /></a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" title="Create this driver's Slack channel" onClick={() => void openSlackWizard(selected)}>
              <Hash className="size-3.5" />{isMobile ? '' : 'Create Slack channel'}
            </Button>
          )) : null}
          <Button variant="outline" size="sm" className="h-8" title={selected.status === 'ARCHIVED' ? 'Reopen' : 'Archive'} onClick={() => void act('archive', () => d.setArchived(selected.id, selected.status !== 'ARCHIVED'))}>
            {selected.status === 'ARCHIVED' ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </Button>
        </div>
      </div>
      {d.status?.slackBridge && !selected.slackChannelId && selected.lastDirection === 'IN' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: 'var(--ds-blue-bg)', borderBottom: '1px solid var(--ds-border)', fontSize: 13 }}>
          <Hash className="size-4" style={{ color: 'var(--ds-blue)' }} />
          <span style={{ flex: 1 }}>{conversationTitle(selected)} has no Slack channel yet. Create one so the team can answer from Slack.</span>
          <Button size="sm" className="h-7" onClick={() => void openSlackWizard(selected)}>Set up channel</Button>
        </div>
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
      />
    </div>
  ) : (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ds-t3)', fontSize: 13, background: 'var(--ds-bg)' }}>
      Pick a conversation, or start a new message.
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {header}
      {banner}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {showList ? list : null}
        {showThread ? thread : null}
      </div>
      {newOpen ? <NewMessageDialog onClose={() => setNewOpen(false)} onStart={async (input) => { const c = await d.start(input); setTab(c.status === 'ARCHIVED' ? 'ARCHIVED' : 'OPEN'); d.select(c.id); return c }} /> : null}
      {linking ? <LinkNumberDialog key={linking.id} conversation={linking} onClose={() => setLinking(null)} onLink={(input) => d.link(linking.id, input)} /> : null}
      {slackWizard ? <SlackChannelWizard key={slackWizard.id} conversation={slackWizard} defaultInvites={wizardInvites(slackWizard)} onClose={() => setSlackWizard(null)} onCreate={(input) => d.createSlackChannel(slackWizard.id, input)} /> : null}
      {assigning ? <AssignDialog key={assigning.id} conversation={assigning} fromDriver={dispatchersOf(assigning.driverId ? drivers.find((x) => x.id === assigning.driverId) : null)} loadStaff={d.listStaff} onClose={() => setAssigning(null)} onSave={(p, b) => d.assign(assigning.id, p, b)} /> : null}
      {settingsOpen ? <DispatchSettingsDialog onClose={() => setSettingsOpen(false)} dispatchNumber={d.status?.dispatchNumber ?? null} load={d.getSettings} save={d.saveSettings} /> : null}
    </div>
  )
}
