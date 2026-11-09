/**
 * Step P8-UI — the shared shipment conversation: bubbles, cards, pills and composer.
 *
 * Powers the shipment Tracking detail panel: bubbles, cards, pills and composer;
 * the detail panel frames its own title and cadence controls.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bold, Italic, List, Link2, Mail, MessageSquare, Paperclip,
  Phone, Send, AtSign, FileUp, X, ExternalLink, Smartphone,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTextarea,
  type TmsTone,
} from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { prettyPhone } from '@/lib/dispatch'
import { trackingThreadMessages } from '@/lib/shipmentThread'
import type { SmsTarget } from '@/lib/workPhone'
import type { ShipmentBundle, ShipmentMessageRecord } from '@/types/tms'
import {
  commitDocument, prepareDocumentUpload, putPresignedFile,
} from '@/lib/apiClient'
import { ACCEPTED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '@/lib/shipmentDocuments'
import type { ShipmentDocumentType } from '@/types/tms'
import { useStaff } from '@/hooks/useStaff'
import { displayName } from '@/lib/roles'
import '@/features/tms/styles/conversation.css'

// ── Icons ────────────────────────────────────────────────────────────────────

const CHANNEL_ICONS: Record<string, typeof Mail> = {
  EMAIL: Mail,
  SMS: MessageSquare,
  VOICE: Phone,
}

// ── Types ────────────────────────────────────────────────────────────────────

type RecipientKey = 'driver' | 'dispatcher'
type ComposerChannel = 'EMAIL' | 'SMS'

export interface TrackingConversationRecipient {
  name?: string | null
  phone?: string | null
  email?: string | null
}

export interface TrackingConversationProps {
  /** Every message on the shipment; filtered and sorted internally. */
  messages: ShipmentMessageRecord[]
  loading?: boolean
  /** Signed-in person, for the signature preview. */
  userName?: string | null
  driver?: TrackingConversationRecipient | null
  dispatcher?: TrackingConversationRecipient | null
  /** Change when the underlying conversation changes — resets composer. */
  conversationKey?: string
  /** The bundle the conversation sits beside, for the load summary card and header. */
  bundle?: ShipmentBundle | null
  /** True = show every message unfiltered (full history view). */
  filtersOff?: boolean
  /**
   * One pane of the two-pane view: only this channel's messages, no recipient/channel selects,
   * no formatting toolbar, a one-line header and a two-row composer. SMS goes to the driver
   * (the server picks the number), e-mail to the dispatcher.
   */
  lockChannel?: ComposerChannel
  /** SMS pane: where a text will land, resolved with the same rule the server uses. */
  smsTarget?: SmsTarget | null
  onSendMessage: (input: {
    channel: ComposerChannel
    to: string | null
    subject: string | null
    body: string
    documentIds?: string[]
    party?: 'DRIVER' | 'DISPATCHER'
  }) => Promise<void>
  onRefresh: () => void | Promise<void>
}

interface PendingFile {
  file: File
  documentId?: string
  s3Key?: string
  error?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "maria.gomez@bcat.com" → "Maria". */
function firstName(name: string | null | undefined): string {
  if (!name) return 'you'
  const local = name.split('@')[0] || name
  const part = local.split(/[._\s]/)[0] || local
  if (!part) return 'you'
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
}

function partyLabel(m: ShipmentMessageRecord): string {
  if (m.authorKind === 'AGENT') return 'BCAT Tracking Assistant'
  if (m.authorKind === 'PERSON' && m.authorName) return m.authorName
  if (m.party) return m.party.toLowerCase()
  return m.direction === 'IN' ? 'inbound' : 'outbound'
}

function authorBadge(m: ShipmentMessageRecord): { text: string; title: string; kind: string } {
  if (m.authorKind === 'AGENT') return { text: 'Agent', title: 'Sent by BCAT Tracking Assistant', kind: 'agent' }
  if (m.authorKind === 'PERSON') {
    const name = m.authorName ?? 'a person'
    return { text: `Person — ${firstName(name)}`, title: `Sent by ${name}`, kind: 'person' }
  }
  return { text: 'Unknown', title: 'Sender not recorded', kind: 'unknown' }
}

function statusToneFor(status: ShipmentMessageRecord['status']) {
  switch (status) {
    case 'SENT': return 'green' as const
    case 'RECEIVED': return 'blue' as const
    case 'FAILED': return 'red' as const
    default: return 'gray' as const
  }
}

const KIND_LABELS: Record<string, string> = {
  RATE_CON: 'Rate confirmation',
  CHECK_CALL: 'Check call',
  CHECK_CALL_REPLY: 'Location reply',
  POD_REQUEST: 'POD requested',
  POD_REPLY: 'POD received',
  ESCALATION: 'Escalation',
  NOTE: 'Team note',
  OTHER: 'Message',
}

const KIND_TONES: Record<string, TmsTone> = {
  RATE_CON: 'turquoise',
  CHECK_CALL: 'blue',
  CHECK_CALL_REPLY: 'green',
  POD_REQUEST: 'orange',
  POD_REPLY: 'green',
  ESCALATION: 'red',
  NOTE: 'gray',
  OTHER: 'gray',
}

/** Safe Markdown subset → inline JSX. No HTML, no XSS. */
function safeMarkdown(body: string | null | undefined): string {
  if (!body) return ''
  // Encode any HTML that survived into the text.
  let s = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/^-\s(.+)$/gm, '• <span class="tms-convo-md-li">$1</span>')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  s = s.replace(/\n/g, '<br/>')
  return s
}

/** Dollar in cents to human string: 250000 → "$2,500.00". */
function fmtRate(cents: number | null | undefined): string {
  if (!cents) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

// ── Cards ────────────────────────────────────────────────────────────────────
// Structured cards appear inside the message stream for machine-generated events.

function LoadSummaryCard({ bundle }: { bundle: ShipmentBundle }) {
  const load = bundle.loads[0]
  const carrier = bundle.loadCarriers.find((c) => c.loadId === load?.id && c.status === 'ACTIVE')
  const stops = load?.stops ?? []
  const pickup = stops.find((s) => s.type === 'pickup')
  const delivery = stops.find((s) => s.type === 'delivery')
  const rate = carrier?.carrierRateCents ?? load?.rate ? (load.rate! * 100) : undefined
  return (
    <TmsCard className="tms-convo-card tms-convo-card-load">
      <div className="tms-convo-card-title">
        <MessageSquare size={14} /> Load summary
      </div>
      {carrier ? (
        <div className="tms-convo-card-body">
          <div className="tms-convo-card-row">
            <span className="tms-convo-card-label">Carrier</span>
            <span className="tms-convo-card-value">{carrier.carrierName ?? '—'}</span>
          </div>
          <div className="tms-convo-card-row">
            <span className="tms-convo-card-label">DOT / MC</span>
            <span className="tms-convo-card-value">
              {carrier.carrierMc ? (
                <a
                  href={`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${encodeURIComponent(carrier.carrierMc)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {carrier.carrierMc} <ExternalLink size={10} style={{ display: 'inline' }} />
                </a>
              ) : '—'}
            </span>
          </div>
          {rate != null && rate > 0 ? (
            <div className="tms-convo-card-row">
              <span className="tms-convo-card-label">Rate</span>
              <span className="tms-convo-card-value">{fmtRate(rate)}</span>
            </div>
          ) : null}
          <div className="tms-convo-card-row">
            <span className="tms-convo-card-label">Stops</span>
            <span className="tms-convo-card-value">
              {pickup?.address?.city ?? pickup?.name ?? '—'} → {delivery?.address?.city ?? delivery?.name ?? '—'}
            </span>
          </div>
        </div>
      ) : (
        <div className="tms-convo-card-body">
          <div className="tms-convo-card-row">
            <span className="tms-convo-card-label">Stops</span>
            <span className="tms-convo-card-value">
              {pickup?.address?.city ?? pickup?.name ?? '—'} → {delivery?.address?.city ?? delivery?.name ?? '—'}
            </span>
          </div>
        </div>
      )}
    </TmsCard>
  )
}

function TrackingLinkSentCard({ message }: { message: ShipmentMessageRecord }) {
  const failed = message.status === 'FAILED'
  return (
    <TmsCard className="tms-convo-card tms-convo-card-link" data-testid="convo-tracking-link-card">
      <div className="tms-convo-card-title">
        <Link2 size={14} /> Tracking link{failed ? ' not sent' : ' sent'}
        <TmsBadge tone="blue">Link</TmsBadge>
      </div>
      <div className="tms-convo-card-body">
        <span className="tms-convo-card-time">{formatDateTime(message.at)}</span>
        {message.body ? <span> · {message.body}</span> : null}
      </div>
    </TmsCard>
  )
}

/** What the driver did in the tracking page (accepted the link, tapped a status): an app update, never a text. */
const isAppUpdate = (message: ShipmentMessageRecord): boolean => message.from === 'Driver app'

function AppUpdateCard({ message }: { message: ShipmentMessageRecord }) {
  return (
    <TmsCard className="tms-convo-card tms-convo-card-app" data-testid="convo-app-update-card">
      <div className="tms-convo-card-title">
        <Smartphone size={14} /> App update
        <TmsBadge tone="green">App</TmsBadge>
      </div>
      <div className="tms-convo-card-body">
        <span className="tms-convo-card-time">{formatDateTime(message.at)}</span>
        <span> · {message.body}</span>
      </div>
    </TmsCard>
  )
}

function PodReceivedCard({ message }: { message: ShipmentMessageRecord }) {
  return (
    <TmsCard className="tms-convo-card tms-convo-card-pod" data-testid="convo-pod-card">
      <div className="tms-convo-card-title">
        <FileUp size={14} /> POD received
      </div>
      <div className="tms-convo-card-body">
        <span className="tms-convo-card-time">{formatDateTime(message.at)}</span>
        {message.attachments && message.attachments.length > 0 && (
          <div className="tms-convo-card-files">
            {message.attachments.map((att, i) => (
              <span key={i} className="tms-convo-card-file">
                <Paperclip size={10} /> {att.name}
                {att.sizeBytes != null ? ` (${Math.round(att.sizeBytes / 1024)} KB)` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </TmsCard>
  )
}

// ── Thread Row ───────────────────────────────────────────────────────────────

const ThreadRow = memo(function ThreadRow({ message }: { message: ShipmentMessageRecord }) {
  const Icon = CHANNEL_ICONS[message.channel] ?? Mail
  const isOutbound = message.direction === 'OUT'
  const notSent = message.status === 'NOT_SENT'
  const author = authorBadge(message)

  if (isAppUpdate(message)) return <AppUpdateCard message={message} />
  if (message.trackingLinkId) return <TrackingLinkSentCard message={message} />
  if (message.kind === 'POD_REPLY') return <PodReceivedCard message={message} />

  return (
    <li className={`tms-thread-row${isOutbound ? ' tms-thread-out' : ' tms-thread-in'}`}>
      <div className="tms-thread-stack">
        <div className="tms-thread-bubble">
          {message.subject && <p className="tms-thread-subject">{message.subject}</p>}
          <p
            className="tms-thread-body"
            dangerouslySetInnerHTML={{ __html: safeMarkdown(message.body) }}
          />
          {message.attachments && message.attachments.length > 0 && (
            <div className="tms-convo-bubble-files">
              {message.attachments.map((att, i) => (
                <span key={i} className="tms-convo-file-chip" title={`${att.name}${att.sizeBytes != null ? ` (${Math.round(att.sizeBytes / 1024)} KB)` : ''}`}>
                  <Paperclip size={10} /> {att.name}
                </span>
              ))}
            </div>
          )}
          {notSent && message.body && (
            <div className="tms-thread-not-sent">
              <strong>Would have sent:</strong>
              <p data-testid="not-sent-body">{message.body}</p>
            </div>
          )}
        </div>
        <div className="tms-thread-meta">
          <Icon size={12} aria-hidden />
          <span className="tms-thread-party" title={author.title}>{partyLabel(message)}</span>
          <span className="tms-thread-time">{formatDateTime(message.at)}</span>
          {message.to && <span className="tms-thread-to">→ {message.to}</span>}
          {message.channel === 'SMS' && <TmsBadge tone="gray" data-testid="thread-text-badge">Text</TmsBadge>}
          <TmsBadge tone="gray" title={author.title} data-testid="thread-author">
            {author.text}
          </TmsBadge>
          {(notSent || message.status === 'FAILED') && (
            <TmsBadge tone={statusToneFor(message.status)}>{message.status}</TmsBadge>
          )}
        </div>
      </div>
    </li>
  )
})

// ── Kind Pill ────────────────────────────────────────────────────────────────
// Rendered between message groups, above the first message of each kind.

function KindPill({ kind }: { kind: string }) {
  const label = KIND_LABELS[kind] ?? kind
  const tone = KIND_TONES[kind] ?? 'gray'
  return (
    <li className="tms-convo-kind-pill">
      <TmsBadge tone={tone} data-testid="convo-kind-pill">
        {label}
      </TmsBadge>
    </li>
  )
}

// ── Composer Markdown Toolbar ────────────────────────────────────────────────

interface FormatBtn {
  icon: typeof MessageSquare
  markdown: string  // template with $1 for selection
  label: string
}

const FORMAT_BUTTONS: FormatBtn[] = [
  { icon: Bold, markdown: '**$1**', label: 'Bold' },
  { icon: Italic, markdown: '*$1*', label: 'Italic' },
  { icon: List, markdown: '\n- $1', label: 'List' },
  { icon: Link2, markdown: '[$1](url)', label: 'Link' },
]

// ── Locked-pane header ───────────────────────────────────────────────────────

/** One line over a single-channel pane: who the channel talks to and the address it will use. */
function PaneHeader({ channel, driver, dispatcher, smsTarget }: {
  channel: ComposerChannel
  driver?: TrackingConversationRecipient | null
  dispatcher?: TrackingConversationRecipient | null
  smsTarget?: SmsTarget | null
}) {
  const Icon = channel === 'SMS' ? MessageSquare : Mail
  if (channel === 'EMAIL') {
    return (
      <div className="tms-convo-head" data-testid="pane-head-email">
        <Icon size={13} aria-hidden /> <strong>E-mail</strong>
        <span className="tms-muted">· {dispatcher?.name ?? 'dispatcher'}</span>
        <span className="tms-convo-addr" title={dispatcher?.email ?? undefined}>{dispatcher?.email ?? 'no e-mail on file'}</span>
      </div>
    )
  }
  const source = smsTarget?.source === 'WORK'
    ? `work phone${smsTarget.phones.truckNumber ? ` (truck ${smsTarget.phones.truckNumber})` : ''}`
    : smsTarget?.source === 'PERSONAL' ? 'personal phone' : null
  return (
    <div className="tms-convo-head" data-testid="pane-head-sms">
      <Icon size={13} aria-hidden /> <strong>SMS</strong>
      <span className="tms-muted">· {driver?.name ?? 'driver'}</span>
      <span className="tms-convo-addr" data-testid="sms-target" title={smsTarget?.reason ?? undefined}>
        {smsTarget?.to ? <>To {prettyPhone(smsTarget.to)}{source ? ` · ${source}` : ''}</> : 'no number'}
      </span>
      {smsTarget?.reason ? <span className="tms-convo-warn" data-testid="sms-target-reason">{smsTarget.reason}</span> : null}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function TrackingConversation({
  messages,
  loading,
  userName,
  driver,
  dispatcher,
  conversationKey,
  bundle,
  filtersOff = false,
  lockChannel,
  smsTarget,
  onSendMessage,
  onRefresh,
}: TrackingConversationProps) {
  const [busy, setBusy] = useState(false)
  const [recipient, setRecipient] = useState<RecipientKey>('driver')
  const [channel, setChannel] = useState<ComposerChannel>('SMS')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [showMentions, setShowMentions] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const locked = lockChannel != null

  // Staff list for @mentions (polls every 5 min).
  const staff = useStaff(userName)

  // Close the mention dropdown on outside click.
  useEffect(() => {
    if (!showMentions || !mentionRef.current) return
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        setShowMentions(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [showMentions])

  // Reset composer on conversation change.
  const [prevKey, setPrevKey] = useState(conversationKey)
  if (prevKey !== conversationKey) {
    setPrevKey(conversationKey)
    setRecipient('driver')
    setChannel('SMS')
    setSubject('')
    setBody('')
    setPendingFiles([])
  }

  // Locked panes fix both choices; the free composer keeps them in state.
  const activeChannel: ComposerChannel = lockChannel ?? channel
  const activeRecipient: RecipientKey = lockChannel ? (lockChannel === 'SMS' ? 'driver' : 'dispatcher') : recipient

  const recipientAddress = useMemo(() => {
    if (lockChannel === 'SMS') return smsTarget?.to ?? null
    const party = activeRecipient === 'driver' ? driver : dispatcher
    if (!party) return null
    return activeChannel === 'EMAIL' ? (party.email ?? null) : (party.phone ?? null)
  }, [lockChannel, smsTarget, activeRecipient, activeChannel, driver, dispatcher])

  const recipientAvailable = Boolean(recipientAddress)

  const signature = useMemo(() => `— ${firstName(userName)}, BCAT Tracking`, [userName])

  // Filter out offers/quotes/tenders, start at first RATE_CON.
  const sortedMessages = useMemo(() => {
    const src = filtersOff ? messages : trackingThreadMessages(messages)
    return [...src]
      .filter((m) => !lockChannel || m.channel === lockChannel)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }, [messages, filtersOff, lockChannel])

  // Build the thread items: messages interspersed with kind pills and cards.
  interface ThreadItem {
    kind: 'pill' | 'message' | 'load-card'
    at: string
    // Only one set per item.
    pillKind?: string
    message?: ShipmentMessageRecord
  }

  const threadItems = useMemo((): ThreadItem[] => {
    const items: ThreadItem[] = []

    // If we have a bundle and messages, slot the load card before the first real message.
    if (bundle && !locked && sortedMessages.length > 0) {
      items.push({ kind: 'load-card', at: sortedMessages[0].at })
    }

    let lastKind = ''
    for (const m of sortedMessages) {
      // Kind pill when kind changes (card kinds excluded — they are their own pill).
      if (m.kind !== lastKind && m.kind !== 'POD_REPLY' && !m.trackingLinkId) {
        items.push({ kind: 'pill', at: m.at, pillKind: m.kind })
        lastKind = m.kind
      }
      items.push({ kind: 'message', at: m.at, message: m })
    }
    // Sort within the same timestamp: pills first, then load-card, then messages.
    items.sort((a, b) => {
      const ta = Date.parse(a.at)
      const tb = Date.parse(b.at)
      if (ta !== tb) return ta - tb
      const order: Record<string, number> = { pill: 0, 'load-card': 1, message: 2 }
      return order[a.kind] - order[b.kind]
    })
    return items
  }, [sortedMessages, bundle, locked])

  const send = useCallback(async () => {
    if (!body.trim() || !recipientAvailable) return
    setBusy(true)
    const documentIds = pendingFiles.filter((f) => f.documentId).map((f) => f.documentId!)
    try {
      await onSendMessage({
        channel: activeChannel,
        // The SMS pane leaves the number to the server (truck phone first), which writes the one it used.
        to: lockChannel === 'SMS' ? null : recipientAddress ?? null,
        subject: activeChannel === 'EMAIL' ? (subject.trim() || null) : null,
        body: body.trim(),
        party: activeRecipient.toUpperCase() as 'DRIVER' | 'DISPATCHER',
        ...(documentIds.length > 0 ? { documentIds } : {}),
      })
      toast.success('Message sent')
      setBody('')
      setSubject('')
      setPendingFiles([])
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }, [body, recipientAvailable, recipientAddress, lockChannel, activeChannel, activeRecipient, subject, onSendMessage, onRefresh, pendingFiles])

  // ── File handling ──────────────────────────────────────────────────────────

  const handleFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    const shipmentId = bundle?.shipment?.id
    if (!shipmentId) {
      toast.error('Cannot attach files without a shipment')
      return
    }
    const newPending: PendingFile[] = Array.from(files).map((file) => ({ file }))
    setPendingFiles((prev) => [...prev, ...newPending])

    setUploadingFiles(true)
    for (const pf of newPending) {
      try {
        if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(pf.file.type)) {
          pf.error = `${pf.file.name} is not a supported file type`
          continue
        }
        if (pf.file.size > MAX_DOCUMENT_BYTES) {
          pf.error = `${pf.file.name} exceeds the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB limit`
          continue
        }
        const prepared = await prepareDocumentUpload({
          shipmentId,
          type: 'OTHER' as ShipmentDocumentType,
          name: pf.file.name,
          contentType: pf.file.type || 'application/octet-stream',
          sizeBytes: pf.file.size,
        })
        await putPresignedFile(prepared.uploadUrl, pf.file, pf.file.type || 'application/octet-stream')
        await commitDocument({
          shipmentId,
          documentId: prepared.documentId,
          s3Key: prepared.s3Key,
          type: 'OTHER',
          name: pf.file.name,
          contentType: pf.file.type || 'application/octet-stream',
          sizeBytes: pf.file.size,
          audience: 'CARRIER',
        })
        pf.documentId = prepared.documentId
        pf.s3Key = prepared.s3Key
      } catch (err) {
        pf.error = err instanceof Error ? err.message : 'Upload failed'
      }
    }
    setUploadingFiles(false)
    // Force re-render with updated pendingFiles.
    setPendingFiles((prev) => [...prev])
  }, [bundle])

  const removePendingFile = useCallback((idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const canSend = body.trim().length > 0 && recipientAvailable && !busy && !uploadingFiles
  const attachmentEnabled = activeChannel === 'EMAIL'
  const hasError = pendingFiles.some((f) => f.error)

  // ── Markdown formatting ────────────────────────────────────────────────────

  const applyFormat = useCallback((fmt: FormatBtn) => {
    const textarea = composerRef.current?.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) {
      setBody((prev) => prev + fmt.markdown.replace('$1', ''))
      return
    }
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = body.slice(start, end)
    const replacement = fmt.markdown.replace('$1', selected || '')
    const newBody = body.slice(0, start) + replacement + body.slice(end)
    setBody(newBody)
    // Restore cursor after the inserted markdown.
    requestAnimationFrame(() => {
      textarea.focus()
      const pos = start + replacement.length
      textarea.setSelectionRange(pos, pos)
    })
  }, [body])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div data-testid="tracking-thread" className={`tms-convo-root${locked ? ' tms-convo-compact' : ''}`} data-channel={lockChannel}>
      {lockChannel && <PaneHeader channel={lockChannel} driver={driver} dispatcher={dispatcher} smsTarget={smsTarget} />}
      {/* Messages + cards + pills */}
      <div className="tms-convo-stream" data-testid="convo-stream">
        {loading ? (
          <p className="tms-muted text-sm">Loading thread…</p>
        ) : threadItems.length === 0 ? (
          <TmsEmptyState compact title="No messages" message={lockChannel === 'SMS' ? 'No texts with the driver yet.' : lockChannel === 'EMAIL' ? 'No e-mails with the dispatcher yet.' : 'Send a message to start the thread.'} />
        ) : (
          <ul className="tms-thread-list" data-testid="detail-thread">
            {threadItems.map((item, idx) => {
              if (item.kind === 'load-card') {
                return bundle ? <LoadSummaryCard key="load-summary" bundle={bundle} /> : null
              }
              if (item.kind === 'pill') {
                return <KindPill key={`pill-${idx}-${item.pillKind}`} kind={item.pillKind!} />
              }
              return item.message ? <ThreadRow key={item.message.id} message={item.message} /> : null
            })}
          </ul>
        )}
      </div>

      {/* Composer */}
      <div className="tms-thread-composer" data-testid="thread-composer" ref={composerRef}>
        {/* Formatting toolbar */}
        {!locked && <div className="tms-convo-toolbar" role="toolbar" aria-label="Formatting">
          {FORMAT_BUTTONS.map((fmt) => (
            <TmsButton
              key={fmt.label}
              size="sm"
              variant="ghost"
              onClick={() => applyFormat(fmt)}
              title={fmt.label}
              aria-label={fmt.label}
            >
              <fmt.icon size={14} />
            </TmsButton>
          ))}
        </div>}

        {lockChannel === 'EMAIL' && (
          <TmsInput aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        )}
        {!locked && <div className="tms-thread-composer-top">
          <TmsSelect
            aria-label="Recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value as RecipientKey)}
            options={[
              { value: 'driver', label: driver?.name ? `Driver — ${driver.name}` : 'Driver' },
              { value: 'dispatcher', label: dispatcher?.name ? `Dispatcher — ${dispatcher.name}` : 'Dispatcher' },
            ]}
          />
          <TmsSelect
            aria-label="Channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as ComposerChannel)}
          >
            <option value="SMS">SMS</option>
            <option value="EMAIL">E-mail</option>
            <option value="VOICE" disabled>Voice (coming soon)</option>
          </TmsSelect>
          {channel === 'EMAIL' && (
            <TmsInput
              aria-label="Subject"
              placeholder="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          )}
        </div>}

        {locked ? (
          <>
            <TmsTextarea
              aria-label={lockChannel === 'SMS' ? 'Text message body' : 'E-mail body'}
              placeholder={lockChannel === 'SMS' ? 'Text the driver…' : 'E-mail the dispatcher…'}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
            />
            <span className="tms-thread-signature-preview tms-convo-sig" data-testid="signature-preview">
              The server will sign it: <em>{signature}</em>
            </span>
          </>
        ) : (
        <TmsField
          label="Message"
          hint={
            <span className="tms-thread-signature-preview" data-testid="signature-preview">
              The server will sign it: <em>{signature}</em>
            </span>
          }
        >
          <TmsTextarea
            aria-label="Message body"
            placeholder="Type a message…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
          />
        </TmsField>
        )}

        {/* Attachments bar */}
        {pendingFiles.length > 0 && (
          <div className="tms-convo-attach-bar">
            {pendingFiles.map((pf, idx) => (
              <span
                key={idx}
                className={`tms-convo-file-chip${pf.error ? ' tms-convo-file-error' : pf.documentId ? ' tms-convo-file-uploaded' : ''}`}
                title={pf.error ?? (pf.documentId ? 'Uploaded' : 'Uploading…')}
              >
                {pf.error ? (
                  <X size={10} className="tms-convo-file-x" onClick={() => removePendingFile(idx)} />
                ) : (
                  <Paperclip size={10} />
                )}
                {' '}{pf.file.name}
                {pf.error && <span className="tms-convo-file-err-text"> — {pf.error}</span>}
              </span>
            ))}
          </div>
        )}

        <div className="tms-thread-composer-foot">
          <div className="tms-convo-composer-actions">
            {lockChannel !== 'SMS' && (
            <TmsButton
              size="sm"
              variant="ghost"
              disabled={!attachmentEnabled || uploadingFiles}
              title={!attachmentEnabled ? 'Attachments are sent by e-mail' : uploadingFiles ? 'Uploading attachments…' : 'Attach a file'}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={14} />
            </TmsButton>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_CONTENT_TYPES.join(',')}
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files; void handleFiles(f); e.target.value = '' }}
            />
            {!locked && <TmsButton
              size="sm"
              variant="ghost"
              title="Mention a team member"
              onClick={() => setShowMentions((prev) => !prev)}
            >
              <AtSign size={14} />
            </TmsButton>}
            {!locked && showMentions && (
              <div className="tms-convo-mention-dropdown" ref={mentionRef}>
                {staff.staff.length === 0 && !staff.loading ? (
                  <span className="tms-convo-mention-empty">No team members</span>
                ) : (
                  staff.staff.map((p) => {
                    const name = displayName(p)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="tms-convo-mention-item"
                        onClick={() => {
                          const mention = `@${name} `
                          const textarea = composerRef.current?.querySelector<HTMLTextAreaElement>('textarea')
                          if (textarea) {
                            const s = textarea.selectionStart
                            setBody(body.slice(0, s) + mention + body.slice(s))
                          } else {
                            setBody((prev) => prev + mention)
                          }
                          setShowMentions(false)
                        }}
                      >
                        {name}{p.email ? ` (${p.email})` : ''}
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
          <TmsButton
            variant="primary"
            size="sm"
            disabled={!canSend}
            onClick={() => void send()}
          >
            <Send size={14} aria-hidden /> {busy ? 'Sending…' : 'Send'}
          </TmsButton>
        </div>
        {!recipientAvailable && (
          <p className="tms-thread-composer-error">
            {lockChannel === 'SMS'
              ? (smsTarget?.reason ?? 'No phone for this driver.')
              : activeRecipient === 'driver'
                ? `This driver has no ${activeChannel === 'EMAIL' ? 'e-mail' : 'phone'} on file.`
                : `This dispatcher has no ${activeChannel === 'EMAIL' ? 'e-mail' : 'phone'} on file.`}
          </p>
        )}
        {hasError && (
          <p className="tms-thread-composer-error">One or more attachments failed to upload.</p>
        )}
      </div>
    </div>
  )
}

export default TrackingConversation