import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Pause, RotateCcw, ChevronLeft, Send, Mail, BarChart3, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useCarrierCampaigns, useCarrierContacts } from '@/hooks/useCarrierBlast'
import { carrierBlast } from '@/lib/apiClient'
import { useAuth } from '@/hooks/useAuth'
import type { CarrierLane, CarrierCampaign } from '@/types'
import { LANE_LABEL } from '@/types'

interface InstantlyAccount {
  email: string
  status: string
  warmupStatus: string
  dailyLimit: number
  warmupScore: number
  provider: string
  ok: boolean
}

interface ListAccountsResponse {
  ok: boolean
  error?: string | null
  accounts: InstantlyAccount[]
  totalDailyCapacity: number
  defaultPerMailbox: number
  reservePerMailbox: number
  maxPerMailbox: number
}

function textToHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br/>')
}

const FALLBACK_DEFAULT_PER_MAILBOX = 12
const FALLBACK_RESERVE_PER_MAILBOX = 25
const FALLBACK_MAX_PER_MAILBOX = 15

export function CampaignsTab() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { items: campaigns, loading, addCampaign, runAction } = useCarrierCampaigns()
  const { counts: ilIaCounts } = useCarrierContacts('IL_IA')
  const { counts: ilWiCounts } = useCarrierContacts('IL_WI')
  const [creating, setCreating] = useState(false)
  const [accounts, setAccounts] = useState<InstantlyAccount[]>([])
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [defaultPerMailbox, setDefaultPerMailbox] = useState(FALLBACK_DEFAULT_PER_MAILBOX)
  const [reservePerMailbox, setReservePerMailbox] = useState(FALLBACK_RESERVE_PER_MAILBOX)
  const [maxPerMailbox, setMaxPerMailbox] = useState(FALLBACK_MAX_PER_MAILBOX)

  const activeCounts = { IL_IA: ilIaCounts.active, IL_WI: ilWiCounts.active }

  useEffect(() => {
    setAccountsLoading(true)
    carrierBlast('listAccounts')
      .then((res) => {
        if (!res.ok) throw new Error(res.error ?? 'failed')
        const data = res as unknown as ListAccountsResponse
        setAccounts(data.accounts ?? [])
        setDefaultPerMailbox(data.defaultPerMailbox ?? FALLBACK_DEFAULT_PER_MAILBOX)
        setReservePerMailbox(data.reservePerMailbox ?? FALLBACK_RESERVE_PER_MAILBOX)
        setMaxPerMailbox(data.maxPerMailbox ?? FALLBACK_MAX_PER_MAILBOX)
      })
      .catch((err) => toast.error(`Couldn't load sender accounts: ${err instanceof Error ? err.message : 'unknown error'}`))
      .finally(() => setAccountsLoading(false))
  }, [])

  const detail = useMemo(() => campaigns.find((c) => c.id === detailId) ?? null, [campaigns, detailId])

  if (detail) {
    return (
      <CampaignDetail
        campaign={detail}
        onBack={() => setDetailId(null)}
        onAction={runAction}
        onViewReplies={(id) => navigate('/carriers', { state: { tab: 'replies', campaignId: id } })}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>Campaigns</h2>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Mail size={14} /> New campaign
        </Button>
      </div>

      {creating && (
        <CampaignComposer
          accounts={accounts}
          accountsLoading={accountsLoading}
          activeCounts={activeCounts}
          defaultPerMailbox={defaultPerMailbox}
          reservePerMailbox={reservePerMailbox}
          maxPerMailbox={maxPerMailbox}
          onSave={async (draft) => {
            const created = await addCampaign({ ...draft, createdBy: user?.email ?? null })
            setCreating(false)
            return created
          }}
          onCancel={() => setCreating(false)}
          onLaunch={async (campaign) => {
            await runAction(campaign.id, 'launchCampaign')
            toast.success('Campaign launched')
          }}
        />
      )}

      {loading && campaigns.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
      ) : campaigns.length === 0 ? (
        <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '28px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
          No campaigns yet. Create one to start emailing carriers.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {campaigns.map((campaign) => (
            <CampaignCard
              key={campaign.id}
              campaign={campaign}
              activeCount={activeCounts[campaign.lane]}
              onClick={() => setDetailId(campaign.id)}
              onAction={runAction}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CampaignCard({
  campaign,
  activeCount,
  onClick,
  onAction,
}: {
  campaign: CarrierCampaign
  activeCount: number
  onClick: () => void
  onAction: (id: string, action: 'launchCampaign' | 'pauseCampaign' | 'resumeCampaign' | 'syncCampaign') => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)

  const handleAction = async (action: 'pauseCampaign' | 'resumeCampaign' | 'syncCampaign') => {
    setBusy(true)
    try {
      await onAction(campaign.id, action)
      toast.success(action === 'syncCampaign' ? 'Campaign synced' : `Campaign ${action === 'pauseCampaign' ? 'paused' : 'resumed'}`)
    } catch (err) {
      toast.error(`Action failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onClick={onClick}
      style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 16, cursor: 'pointer', boxShadow: 'var(--sh-sm)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', margin: '0 0 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {campaign.name}
          </h3>
          <p style={{ fontSize: 12, color: 'var(--ds-t3)', margin: 0 }}>{LANE_LABEL[campaign.lane]}</p>
        </div>
        <StatusBadge status={campaign.status} />
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ds-t2)', margin: '0 0 12px', lineHeight: 1.4 }}>
        {campaign.subject}
      </p>
      <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: 'var(--ds-t3)', marginBottom: 12 }}>
        <span>{campaign.leadCount} leads</span>
        <span>{campaign.pushedCount} pushed</span>
        <span>{campaign.replyCount} replies</span>
        {activeCount !== undefined && <span>{activeCount} active in lane</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
        {campaign.status === 'sending' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleAction('pauseCampaign')}>
            <Pause size={13} /> Pause
          </Button>
        )}
        {(campaign.status === 'paused' || campaign.status === 'draft') && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleAction('resumeCampaign')}>
            <Play size={13} /> {campaign.status === 'draft' ? 'Launch' : 'Resume'}
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void handleAction('syncCampaign')}>
          <RotateCcw size={13} /> Sync
        </Button>
      </div>
    </div>
  )
}

function CampaignDetail({
  campaign,
  onBack,
  onAction,
  onViewReplies,
}: {
  campaign: CarrierCampaign
  onBack: () => void
  onAction: (id: string, action: 'launchCampaign' | 'pauseCampaign' | 'resumeCampaign' | 'syncCampaign') => Promise<unknown>
  onViewReplies: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)

  const handle = async (action: 'pauseCampaign' | 'resumeCampaign' | 'syncCampaign') => {
    setBusy(true)
    try {
      await onAction(campaign.id, action)
      toast.success(action === 'syncCampaign' ? 'Synced' : 'Updated')
    } catch (err) {
      toast.error(`Action failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--ds-t3)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
          <ChevronLeft size={14} /> Back
        </button>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>{campaign.name}</h2>
        <StatusBadge status={campaign.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        <Counter label="Leads" value={campaign.leadCount} />
        <Counter label="Sent" value={campaign.sentCount} />
        <Counter label="Opened" value={campaign.openCount} />
        <Counter label="Replied" value={campaign.replyCount} />
        <Counter label="Bounced" value={campaign.bounceCount} />
        <Counter label="Unsubscribed" value={campaign.unsubscribeCount} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {campaign.status === 'sending' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handle('pauseCampaign')}>
            <Pause size={13} /> Pause
          </Button>
        )}
        {(campaign.status === 'paused' || campaign.status === 'draft') && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handle('resumeCampaign')}>
            <Play size={13} /> {campaign.status === 'draft' ? 'Launch' : 'Resume'}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void handle('syncCampaign')}>
          <RotateCcw size={13} /> Sync now
        </Button>
        <Button variant="outline" size="sm" onClick={() => onViewReplies(campaign.id)}>
          <MessageSquare size={13} /> Replies
        </Button>
      </div>

      <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', margin: '0 0 10px' }}>Sending configuration</h3>
        <p style={{ fontSize: 12.5, color: 'var(--ds-t2)', margin: '0 0 10px' }}>
          {campaign.senderAccounts.length} mailbox{campaign.senderAccounts.length === 1 ? '' : 'es'} at {campaign.dailyLimit ?? '—'}/day
        </p>
        {campaign.errorText && campaign.errorText.toLowerCase().startsWith('skipped') && (campaign.status === 'sending' || campaign.status === 'completed') && (
          <p style={{ fontSize: 12, color: 'var(--ds-amber)', margin: 0 }}>{campaign.errorText}</p>
        )}
        {campaign.status === 'failed' && campaign.errorText && (
          <p style={{ fontSize: 12, color: 'var(--ds-red)', margin: 0 }}>{campaign.errorText}</p>
        )}
      </div>

      <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', margin: '0 0 10px' }}>Subject</h3>
        <p style={{ fontSize: 12.5, color: 'var(--ds-t2)', margin: '0 0 16px' }}>{campaign.subject}</p>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ds-t1)', margin: '0 0 10px' }}>Body</h3>
        <div
          style={{ fontSize: 12.5, color: 'var(--ds-t2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
          dangerouslySetInnerHTML={{ __html: campaign.bodyHtml }}
        />
      </div>
    </div>
  )
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: '14px 12px', textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ds-t1)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: 0.04 }}>{label}</div>
    </div>
  )
}

function CampaignComposer({
  accounts,
  accountsLoading,
  activeCounts,
  defaultPerMailbox,
  reservePerMailbox,
  maxPerMailbox,
  onSave,
  onCancel,
  onLaunch,
}: {
  accounts: InstantlyAccount[]
  accountsLoading: boolean
  activeCounts: Record<CarrierLane, number>
  defaultPerMailbox: number
  reservePerMailbox: number
  maxPerMailbox: number
  onSave: (draft: Omit<CarrierCampaign, 'id' | 'createdAt' | 'updatedAt'>) => Promise<CarrierCampaign>
  onCancel: () => void
  onLaunch: (campaign: CarrierCampaign) => Promise<void>
}) {
  const { user } = useAuth()
  const [lane, setLane] = useState<CarrierLane>('IL_IA')
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([])
  const [perMailboxLimit, setPerMailboxLimit] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmLaunch, setConfirmLaunch] = useState<CarrierCampaign | null>(null)

  const okAccounts = accounts.filter((a) => a.ok)
  const activeCount = activeCounts[lane]
  const effectivePerMailbox = selectedAccounts.length > 0
    ? Math.min(Math.max(perMailboxLimit ?? defaultPerMailbox, 1), maxPerMailbox)
    : 0
  const totalDailyCap = effectivePerMailbox * selectedAccounts.length
  const days = totalDailyCap > 0 ? Math.ceil(activeCount / totalDailyCap) : null
  const canLaunch = okAccounts.length > 0 && selectedAccounts.length > 0 && totalDailyCap > 0

  const toggleAccount = (email: string) => {
    setSelectedAccounts((prev) => prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email])
  }

  const buildDraft = (): Omit<CarrierCampaign, 'id' | 'createdAt' | 'updatedAt'> => ({
    lane,
    name: name.trim(),
    subject: subject.trim(),
    bodyHtml: textToHtml(body),
    senderAccounts: selectedAccounts,
    dailyLimit: effectivePerMailbox || null,
    status: 'draft',
    leadCount: activeCount,
    pushedCount: 0,
    errorText: null,
    sentCount: 0,
    openCount: 0,
    replyCount: 0,
    bounceCount: 0,
    unsubscribeCount: 0,
    analyticsAt: null,
    createdBy: user?.email ?? null,
    startedAt: null,
    completedAt: null,
  })

  const handleSave = async (thenLaunch: boolean) => {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      toast.error('Name, subject, and body are required')
      return
    }
    if (selectedAccounts.length === 0) {
      toast.error('Select at least one sender account')
      return
    }
    setSaving(true)
    try {
      const draft = buildDraft()
      const campaign = await onSave(draft)
      if (thenLaunch) {
        setConfirmLaunch(campaign)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', margin: 0 }}>New campaign</h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', display: 'block', marginBottom: 6 }}>Lane</label>
          <select
            value={lane}
            onChange={(e) => setLane(e.target.value as CarrierLane)}
            style={{ width: '100%', height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit' }}
          >
            <option value="IL_IA">IL → IA</option>
            <option value="IL_WI">IL → WI</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', display: 'block', marginBottom: 6 }}>Campaign name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IL→IA June outreach" />
        </div>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', display: 'block', marginBottom: 6 }}>Subject</label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your subject line" />
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', display: 'block', marginBottom: 6 }}>Body</label>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Plain text. Use {{firstName}} and {{company}} merge tags." />
        <p style={{ fontSize: 11, color: 'var(--ds-t3)', margin: '6px 0 0' }}>
          Merge tags: {'{{firstName}}'}, {'{{company}}'}. Converted to HTML on save.
        </p>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', display: 'block', marginBottom: 6 }}>
          Sender accounts {accountsLoading && '(loading…)'}
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflow: 'auto', border: '1px solid var(--ds-border)', borderRadius: 8, padding: 8 }}>
          {okAccounts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{accountsLoading ? 'Loading accounts…' : 'No active sender accounts available.'}</div>
          ) : (
            okAccounts.map((acct) => (
              <label key={acct.email} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ds-t2)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selectedAccounts.includes(acct.email)}
                  onChange={() => toggleAccount(acct.email)}
                />
                <span style={{ flex: 1 }}>{acct.email}</span>
                <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>limit {acct.dailyLimit}</span>
                <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>score {acct.warmupScore}</span>
              </label>
            ))
          )}
        </div>
        <p style={{ fontSize: 11, color: 'var(--ds-t3)', margin: '6px 0 0' }}>
          Only warmed jobsdone mailboxes are available for carrier sending.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', display: 'block', marginBottom: 6 }}>
            Per-mailbox daily limit (max {maxPerMailbox})
          </label>
          <Input
            type="number"
            min={1}
            max={maxPerMailbox}
            value={selectedAccounts.length > 0 ? effectivePerMailbox : ''}
            onChange={(e) => {
              const parsed = e.target.value === '' ? defaultPerMailbox : Number(e.target.value)
              setPerMailboxLimit(Math.min(Math.max(parsed, 1), maxPerMailbox))
            }}
            onBlur={() => {
              setPerMailboxLimit((prev) => Math.min(Math.max(prev ?? defaultPerMailbox, 1), maxPerMailbox))
            }}
            placeholder={String(defaultPerMailbox)}
            disabled={selectedAccounts.length === 0}
            data-testid="per-mailbox-limit"
          />
        </div>
        <div data-testid="campaign-estimate" style={{ fontSize: 13, color: 'var(--ds-t2)', background: 'var(--ds-bg)', borderRadius: 8, padding: '10px 12px' }}>
          <BarChart3 size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
          {selectedAccounts.length === 0 || totalDailyCap === 0
            ? 'Select accounts to see capacity'
            : `${selectedAccounts.length} mailbox${selectedAccounts.length === 1 ? '' : 'es'} × ${effectivePerMailbox}/day = ${totalDailyCap}/day${days != null ? ` → ~${days} day${days === 1 ? '' : 's'} for ${activeCount} contacts` : ''}`}
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--ds-t3)', background: 'var(--ds-amber-bg)', borderRadius: 8, padding: '10px 12px' }}>
        {reservePerMailbox}/day per mailbox stays reserved for JobsDone OS outbound. Carrier sending only uses the remainder, so the JobsDone engine is unaffected.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {!canLaunch && (
          <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
            {okAccounts.length === 0
              ? 'No warmed jobsdone mailboxes are available.'
              : 'Select at least one mailbox to launch.'}
          </span>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button variant="secondary" onClick={() => void handleSave(false)} disabled={saving}>Save draft</Button>
          <Button onClick={() => void handleSave(true)} disabled={saving || !canLaunch}>
            <Send size={14} /> Save & Launch
          </Button>
        </div>
      </div>

      {confirmLaunch && (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirmLaunch(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Launch campaign?</DialogTitle>
              <DialogDescription>
                This will push {confirmLaunch.leadCount} active {LANE_LABEL[confirmLaunch.lane]} contacts to Instantly
                from {confirmLaunch.senderAccounts.length} mailbox{confirmLaunch.senderAccounts.length === 1 ? '' : 'es'}.
                {days != null && ` Estimated ~${days} day${days === 1 ? '' : 's'} to reach all contacts.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmLaunch(null)}>Cancel</Button>
              <Button
                onClick={() => {
                  void onLaunch(confirmLaunch)
                  setConfirmLaunch(null)
                }}
              >
                <Play size={14} /> Launch
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: CarrierCampaign['status'] }) {
  const color =
    status === 'sending' ? { bg: 'var(--ds-green-bg)', text: 'var(--ds-green)' } :
    status === 'paused' ? { bg: 'var(--ds-amber-bg)', text: 'var(--ds-amber)' } :
    status === 'draft' ? { bg: 'var(--ds-bg-3)', text: 'var(--ds-t3)' } :
    status === 'completed' ? { bg: 'var(--ds-blue-bg)', text: 'var(--ds-blue-dark)' } :
    status === 'failed' ? { bg: 'var(--ds-red-bg)', text: 'var(--ds-red)' } :
    { bg: 'var(--ds-cyan-bg)', text: 'var(--ds-blue-dark)' }
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
      background: color.bg, color: color.text, textTransform: 'capitalize',
    }}>
      {status}
    </span>
  )
}
