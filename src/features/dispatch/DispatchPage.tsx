import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Archive, ArchiveRestore, MessageSquarePlus, RefreshCw, Search, Settings, UserPlus, UserCheck, Loader2, AlertTriangle, Phone, Hash, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useDispatch } from '@/hooks/useDispatch'
import { useDrivers } from '@/hooks/useDrivers'
import { cn } from '@/lib/utils'
import { conversationTitle, prettyPhone, sortConversations, conversationMatches, type DispatchConversation } from '@/lib/dispatch'
import { ConversationList } from './ConversationList'
import { Thread } from './Thread'
import { NewMessageDialog, LinkNumberDialog, DispatchSettingsDialog, SlackChannelWizard } from './DispatchDialogs'
import { staffName } from './dispatchUi'

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
  const [defaultInvites, setDefaultInvites] = useState<string[] | null>(null)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])

  const me = user?.email?.toLowerCase() ?? ''
  const counts = useMemo(() => ({
    OPEN: d.conversations.filter((c) => c.status !== 'ARCHIVED').length,
    UNREAD: d.conversations.filter((c) => c.status !== 'ARCHIVED' && (c.unreadCount ?? 0) > 0).length,
    MINE: d.conversations.filter((c) => c.status !== 'ARCHIVED' && c.assignedTo === me).length,
    ARCHIVED: d.conversations.filter((c) => c.status === 'ARCHIVED').length,
  }), [d.conversations, me])

  const rows = useMemo(() => sortConversations(d.conversations.filter((c) => {
    if (tab === 'ARCHIVED') return c.status === 'ARCHIVED'
    if (c.status === 'ARCHIVED') return false
    if (tab === 'UNREAD') return (c.unreadCount ?? 0) > 0
    if (tab === 'MINE') return c.assignedTo === me
    return true
  }).filter((c) => conversationMatches(c, query))), [d.conversations, tab, me, query])

  const selected = d.conversations.find((c) => c.id === d.selectedId) ?? null
  const selectedDriver = selected?.driverId ? drivers.find((x) => x.id === selected.driverId) ?? null : null

  // Opening a conversation with unread messages marks it read for the whole team.
  useEffect(() => {
    if (selected && (selected.unreadCount ?? 0) > 0) d.markRead(selected.id).catch(() => { /* next poll will retry */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.unreadCount])

  const assignees = useMemo(() => {
    const set = new Set<string>()
    if (me) set.add(me)
    for (const c of d.conversations) if (c.assignedTo) set.add(c.assignedTo)
    return [...set].sort()
  }, [d.conversations, me])

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
          <ConversationList rows={rows} selectedId={d.selectedId} onSelect={d.select} now={now} />
        )}
      </div>
    </div>
  )

  const thread = selected ? (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: 'var(--ds-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--ds-border)', background: 'var(--ds-surface)' }}>
        {isMobile ? <Button variant="ghost" size="icon" className="size-8" aria-label="Back to conversations" onClick={() => d.select(null)}><ArrowLeft className="size-4" /></Button> : null}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ds-t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversationTitle(selected)}</div>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href={`tel:${selected.phone}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'inherit' }}><Phone className="size-3" />{prettyPhone(selected.phone)}</a>
            {selectedDriver ? <span>{selectedDriver.fleetGroup === 'AMAZON' ? 'Owner operator' : selectedDriver.fleetGroup === 'BOX_TRUCK' ? 'Box truck' : selectedDriver.fleetGroup === 'LOCAL' ? 'Ivan local' : 'Driver'}{selectedDriver.active ? '' : ' · inactive'}</span> : <span>Not a driver on file</span>}
            {selected.assignedTo ? <span>· {selected.assignedTo === me ? 'Yours' : `With ${staffName(selected.assignedTo)}`}</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5"><UserCheck className="size-3.5" />{isMobile ? '' : (selected.assignedTo ? staffName(selected.assignedTo) : 'Assign')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {me && selected.assignedTo !== me ? <DropdownMenuItem onClick={() => void act('assign', () => d.assign(selected.id, me))}>Take it (me)</DropdownMenuItem> : null}
              {assignees.filter((a) => a !== me && a !== selected.assignedTo).map((a) => <DropdownMenuItem key={a} onClick={() => void act('assign', () => d.assign(selected.id, a))}>{a}</DropdownMenuItem>)}
              {selected.assignedTo ? <DropdownMenuItem onClick={() => void act('unassign', () => d.assign(selected.id, null))}>Unassign</DropdownMenuItem> : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" title={selected.driverId ? 'Change who this number belongs to' : 'Link this number to a driver'} onClick={() => setLinking(selected)}>
            <UserPlus className="size-3.5" />{isMobile ? '' : (selected.driverId ? 'Relink' : 'Link driver')}
          </Button>
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
      {slackWizard ? <SlackChannelWizard key={slackWizard.id} conversation={slackWizard} defaultInvites={defaultInvites ?? []} onClose={() => setSlackWizard(null)} onCreate={(input) => d.createSlackChannel(slackWizard.id, input)} /> : null}
      {settingsOpen ? <DispatchSettingsDialog onClose={() => setSettingsOpen(false)} dispatchNumber={d.status?.dispatchNumber ?? null} load={d.getSettings} save={d.saveSettings} /> : null}
    </div>
  )
}
