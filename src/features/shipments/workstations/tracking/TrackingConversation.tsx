/**
 * Step P8-UI — the shared shipment conversation: bubbles, cards, pills and composer.
 *
 * Powers both the shipment Tracking detail (variant="detail") and the Inbox
 * right pane (variant="inbox"). The Inbox header, kind pills and structured cards
 * live here; the detail panel frames its own title and cadence controls.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bold, Italic, List, Link2, Mail, MessageSquare, Paperclip,
  Phone, Send, AtSign, FileUp, X, ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsField, TmsInput, TmsSelect, TmsTextarea,
  type TmsTone,
} from '@/features/tms/kit'
import { formatDateTime } from '@/lib/date'
import { trackingThreadMessages } from '@/lib/shipmentThread'
import type { ShipmentBundle, ShipmentMessageRecord } from '@/types/tms'
import {
  commitDocument, prepareDocumentUpload, putPresignedFile,
} from '@/lib/apiClient'
import { ACCEPTED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '@/lib/shipmentDocuments'
import type { ShipmentDocumentType } from '@/types/tms'
import { useStaff } from '@/hooks/useStaff'
import { displayName } from '@/lib/roles'
import './TrackingConversation.css'

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
  /** "detail" (default) keeps existing testids; "inbox" surfaces inbox‑conversation / inbox‑composer. */
  variant?: 'detail' | 'inbox'
  /** The bundle the conversation sits beside, for the load summary card and header. */
  bundle?: ShipmentBundle | null
  /** True = show every message unfiltered (full history view). */
  filtersOff?: boolean
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
  return (
    <TmsCard className="tms-convo-card tms-convo-card-link" data-testid="convo-tracking-link-card">
      <div className="tms-convo-card-title">
        <Link2 size={14} /> Tracking link sent
      </div>
      <div className="tms-convo-card-body">
        <span className="tms-convo-card-time">{formatDateTime(message.at)}</span>
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
  const isCardMessage =
    message.kind === 'POD_REPLY' || !!message.trackingLinkId

  // If it's a structured card, render that instead of a bubble.
  if (!isCardMessage) {
    // render bubble
  }
  if (message.trackingLinkId) return <TrackingLinkSentCard message={message} />
  if (message.kind === 'POD_REPLY') return <PodReceivedCard message={message} />

  return (
    <li className={`tms-thread-row${isOutbound ? ' tms-thread-out' : ' tms-thread-in'}`}>
      <div className="tms-thread-bubble">
        <div className="tms-thread-meta">
          <Icon size={14} aria-hidden />
          <TmsBadge tone={statusToneFor(message.status)}>{message.status}</TmsBadge>
          <span className="tms-thread-party" title={author.title}>{partyLabel(message)}</span>
          <TmsBadge tone="gray" title={author.title} data-testid="thread-author">
            {author.text}
          </TmsBadge>
          {message.to && <span className="tms-muted">→ {message.to}</span>}
          <span className="tms-muted tms-thread-time">{formatDateTime(message.at)}</span>
        </div>
        {message.subject && <p className="tms-thread-subject">{message.subject}</p>}
        <p
          className="tms-thread-body"
          dangerouslySetInnerHTML={{ __html: safeMarkdown(message.body) }}
        />
        {/* Show attachments on the bubble */}
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

// ── Main Component ───────────────────────────────────────────────────────────

export function TrackingConversation({
  messages,
  loading,
  userName,
  driver,
  dispatcher,
  conversationKey,
  variant = 'detail',
  bundle,
  filtersOff = false,
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

  const isInbox = variant === 'inbox'

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

  const recipientAddress = useMemo(() => {
    const party = recipient === 'driver' ? driver : dispatcher
    if (!party) return null
    return channel === 'EMAIL' ? (party.email ?? null) : (party.phone ?? null)
  }, [recipient, channel, driver, dispatcher])

  const recipientAvailable = Boolean(recipientAddress)

  const signature = useMemo(() => `— ${firstName(userName)}, BCAT Tracking`, [userName])

  // Filter out offers/quotes/tenders, start at first RATE_CON.
  const sortedMessages = useMemo(() => {
    const src = filtersOff ? messages : trackingThreadMessages(messages)
    return [...src].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }, [messages, filtersOff])

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
    if (bundle && sortedMessages.length > 0) {
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
  }, [sortedMessages, bundle])

  const send = useCallback(async () => {
    if (!body.trim() || !recipientAvailable) return
    setBusy(true)
    const documentIds = pendingFiles.filter((f) => f.documentId).map((f) => f.documentId!)
    try {
      await onSendMessage({
        channel,
        to: recipientAddress ?? null,
        subject: channel === 'EMAIL' ? (subject.trim() || null) : null,
        body: body.trim(),
        party: recipient.toUpperCase() as 'DRIVER' | 'DISPATCHER',
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
  }, [body, recipientAvailable, recipientAddress, channel, subject, onSendMessage, onRefresh, pendingFiles, recipient])

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
  const attachmentEnabled = channel === 'EMAIL'
  const hasError = pendingFiles.some((f) => f.error)

  // ── Markdown formatting ────────────────────────────────────────────────────

  const applyFormat = useCallback((fmt: FormatBtn) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="Message body"]')
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

  const rootTestId = isInbox ? 'inbox-conversation' : 'tracking-thread'
  const composerTestId = isInbox ? 'inbox-composer' : 'thread-composer'

  const lastMessageAt = sortedMessages.length > 0
    ? sortedMessages[sortedMessages.length - 1].at
    : null

  return (
    <div data-testid={rootTestId} className="tms-convo-root">
      {/* Inbox header */}
      {isInbox && bundle && (
        <div className="tms-convo-inbox-head" data-testid="convo-inbox-head">
          <span className="tms-convo-inbox-pro">{bundle.shipment.number}</span>
          {lastMessageAt && (
            <span className="tms-convo-inbox-activity">
              Last activity · {formatDateTime(lastMessageAt)}
            </span>
          )}
        </div>
      )}

      {/* Messages + cards + pills */}
      {loading ? (
        <p className="tms-muted text-sm">Loading thread…</p>
      ) : threadItems.length === 0 ? (
        <TmsEmptyState title="No messages" message="Send a message to start the thread." />
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

      {/* Composer */}
      <div className="tms-thread-composer" data-testid={composerTestId}>
        {/* Formatting toolbar */}
        <div className="tms-convo-toolbar" role="toolbar" aria-label="Formatting">
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
        </div>

        <div className="tms-thread-composer-top">
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
        </div>

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
            <TmsButton
              size="sm"
              variant="ghost"
              disabled={!attachmentEnabled || uploadingFiles}
              title={!attachmentEnabled ? 'Attachments are sent by e-mail' : uploadingFiles ? 'Uploading attachments…' : 'Attach a file'}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={14} />
            </TmsButton>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_CONTENT_TYPES.join(',')}
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files; void handleFiles(f); e.target.value = '' }}
            />
            <TmsButton
              size="sm"
              variant="ghost"
              title="Mention a team member"
              onClick={() => setShowMentions((prev) => !prev)}
            >
              <AtSign size={14} />
            </TmsButton>
            {showMentions && (
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
                          const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="Message body"]')
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
            {recipient === 'driver'
              ? `This driver has no ${channel === 'EMAIL' ? 'e-mail' : 'phone'} on file.`
              : `This dispatcher has no ${channel === 'EMAIL' ? 'e-mail' : 'phone'} on file.`}
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