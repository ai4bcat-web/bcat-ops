import { useMemo, useState } from 'react'
import { CheckCircle2, RotateCcw, User, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useCarrierReplies } from '@/hooks/useCarrierBlast'
import { useCarrierCampaigns } from '@/hooks/useCarrierBlast'
import { useAuth } from '@/hooks/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { TEAM_MEMBERS, assigneeLabel } from '@/features/intake/IntakePage'
import { formatDateShort, formatTime } from '@/lib/date'
import { LANE_LABEL } from '@/types'
import type { CarrierReply, CarrierLane, CarrierReplyStatus } from '@/types'

export function RepliesTab({ preselectedCampaignId }: { preselectedCampaignId?: string | null }) {
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const { items: campaigns } = useCarrierCampaigns()
  const [statusFilter, setStatusFilter] = useState<CarrierReplyStatus>('open')
  const [laneFilter, setLaneFilter] = useState<CarrierLane | ''>('')
  const [campaignFilter, setCampaignFilter] = useState<string>(preselectedCampaignId ?? '')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filter = useMemo(() => ({
    status: statusFilter,
    lane: laneFilter || null,
    campaignId: campaignFilter || null,
  }), [statusFilter, laneFilter, campaignFilter])

  const { items, loading, refresh, setStatus, setAssignedTo, sendReply } = useCarrierReplies(filter)

  const selected = useMemo(() => items.find((r) => r.id === selectedId) ?? items[0] ?? null, [items, selectedId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((r) =>
      r.fromEmail.toLowerCase().includes(q) ||
      r.subject.toLowerCase().includes(q) ||
      (r.textBody ?? '').toLowerCase().includes(q)
    )
  }, [items, search])

  const handleStatus = async (id: string, status: CarrierReplyStatus) => {
    try {
      await setStatus(id, status, user?.email)
      toast.success(status === 'handled' ? 'Marked handled' : 'Reopened')
    } catch (err) {
      // toast handled in hook
    }
  }

  const handleAssign = async (id: string, assignedTo: string) => {
    try {
      await setAssignedTo(id, assignedTo)
      toast.success(`Assigned to ${assigneeLabel(assignedTo)}`)
    } catch (err) {
      // toast handled in hook
    }
  }

  const handleSendReply = async (reply: CarrierReply, bodyText: string) => {
    try {
      await sendReply(reply.id, bodyText)
      toast.success('Reply sent')
    } catch (err) {
      toast.error(`Couldn't send reply: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--ds-border)', paddingBottom: 2 }}>
          {(['open', 'handled'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                fontSize: 12.5, fontWeight: 500, padding: '4px 10px', borderRadius: 6,
                border: 'none', background: statusFilter === s ? 'var(--ds-blue-bg)' : 'transparent',
                color: statusFilter === s ? 'var(--ds-blue-dark)' : 'var(--ds-t3)', cursor: 'pointer', fontFamily: 'inherit',
                textTransform: 'capitalize',
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={laneFilter}
          onChange={(e) => setLaneFilter(e.target.value as CarrierLane | '')}
          style={{ height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12.5, fontFamily: 'inherit' }}
        >
          <option value="">All lanes</option>
          <option value="IL_IA">IL → IA</option>
          <option value="IL_WI">IL → WI</option>
        </select>
        <select
          value={campaignFilter}
          onChange={(e) => setCampaignFilter(e.target.value)}
          style={{ height: 32, padding: '0 10px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12.5, fontFamily: 'inherit' }}
        >
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <Input
          placeholder="Search replies…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 240, height: 32 }}
        />
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RotateCcw size={13} /> Refresh
        </Button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 16, minHeight: 0, flexDirection: isMobile ? 'column' : 'row' }}>
        <div style={{ flex: isMobile ? '0 0 auto' : '0 0 340px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', maxHeight: isMobile ? 360 : undefined }}>
          {loading && filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '28px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
              No {statusFilter} replies.
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map((reply) => (
                <ReplyCard
                  key={reply.id}
                  reply={reply}
                  selected={selected?.id === reply.id}
                  onClick={() => setSelectedId(reply.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          {selected ? (
            <ReplyPane
              reply={selected}
              onMarkHandled={() => void handleStatus(selected.id, 'handled')}
              onReopen={() => void handleStatus(selected.id, 'open')}
              onAssign={(email) => void handleAssign(selected.id, email)}
              onSendReply={(text) => void handleSendReply(selected, text)}
            />
          ) : (
            <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: '28px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--ds-t3)' }}>
              Select a reply to view the thread.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReplyCard({ reply, selected, onClick }: { reply: CarrierReply; selected: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: selected ? 'var(--ds-blue-bg)' : 'var(--ds-surface)',
        border: '1px solid var(--ds-border)', borderRadius: 10, padding: 12, cursor: 'pointer',
        boxShadow: selected ? 'inset 3px 0 0 var(--ds-blue)' : 'var(--sh-sm)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ds-t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {reply.fromName || reply.fromEmail}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--ds-t3)', whiteSpace: 'nowrap' }}>
          {formatDateShort(reply.receivedAt)} {formatTime(reply.receivedAt)}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--ds-t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 4 }}>
        {reply.subject}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--ds-t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {reply.snippet || reply.textBody?.slice(0, 80)}
      </div>
    </div>
  )
}

function ReplyPane({
  reply,
  onMarkHandled,
  onReopen,
  onAssign,
  onSendReply,
}: {
  reply: CarrierReply
  onMarkHandled: () => void
  onReopen: () => void
  onAssign: (email: string) => void
  onSendReply: (text: string) => void
}) {
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async () => {
    if (!replyText.trim()) return
    setSending(true)
    try {
      await onSendReply(replyText.trim())
      setReplyText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ds-t1)', margin: '0 0 4px' }}>{reply.subject}</h3>
          <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>
            From {reply.fromName ? `${reply.fromName} ` : ''}&lt;{reply.fromEmail}&gt; ·{' '}
            {reply.lane ? LANE_LABEL[reply.lane] : 'Unknown lane'} ·{' '}
            {formatDateShort(reply.receivedAt)} {formatTime(reply.receivedAt)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {reply.status === 'open' ? (
            <Button variant="outline" size="sm" onClick={onMarkHandled}>
              <CheckCircle2 size={13} /> Mark handled
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onReopen}>
              <RotateCcw size={13} /> Reopen
            </Button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <User size={14} color="var(--ds-t3)" />
        <span style={{ fontSize: 12, color: 'var(--ds-t2)' }}>Assigned to {reply.assignedTo ? assigneeLabel(reply.assignedTo) : '—'}</span>
        <select
          value={reply.assignedTo ?? ''}
          onChange={(e) => onAssign(e.target.value)}
          style={{ height: 28, padding: '0 8px', borderRadius: 6, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)', fontSize: 12, fontFamily: 'inherit' }}
        >
          <option value="">Assign…</option>
          {TEAM_MEMBERS.map((m) => (
            <option key={m.email} value={m.email}>{m.name}</option>
          ))}
        </select>
      </div>

      <div style={{ background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 12.5, color: 'var(--ds-t2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {reply.textBody || reply.snippet || '(No text body)'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Write a reply…"
          rows={5}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={submit} disabled={sending || !replyText.trim()}>
            <Send size={13} /> Send reply
          </Button>
        </div>
      </div>
    </div>
  )
}
