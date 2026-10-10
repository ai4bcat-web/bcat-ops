import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Loader2, Paperclip, Send, X, Phone, PhoneMissed, PhoneIncoming, Voicemail, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatDuration, MAX_SMS_BODY, type DispatchConversation, type DispatchMessage } from '@/lib/dispatch'
import { groupByDay, bubbleTime, deliveryLabel, staffName, acceptFiles, ACCEPTED_MEDIA } from './dispatchUi'
import { MediaThumb, VoicemailPlayer } from './MediaThumb'

interface Props {
  conversation: DispatchConversation
  messages: DispatchMessage[]
  loading: boolean
  now: Date
  canSend: boolean
  getUrl: (key: string) => Promise<string>
  onSend: (body: string, files: File[]) => Promise<void>
  onNote: (body: string) => Promise<void>
}

const TONE_COLOR: Record<string, string> = { ok: 'var(--ds-green)', bad: 'var(--ds-red)', pending: 'var(--ds-t3)', muted: 'var(--ds-t3)' }

function CallRow({ m }: { m: DispatchMessage }) {
  const missed = m.status === 'missed' || m.status === 'voicemail'
  const Icon = missed ? PhoneMissed : m.status === 'answered' ? PhoneIncoming : Phone
  const text = m.status === 'answered' ? `Call answered · ${formatDuration(m.callDurationSec)}`
    : m.status === 'missed' ? 'Missed call'
    : m.status === 'voicemail' ? 'Missed call · went to voicemail'
    : 'Incoming call'
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: missed ? 'var(--ds-red)' : 'var(--ds-t2)', background: 'var(--ds-bg-2)', borderRadius: 999, padding: '4px 10px' }}>
        <Icon className="size-3.5" /> {text} · {bubbleTime(m.at)}
      </span>
    </div>
  )
}

function Bubble({ m, getUrl }: { m: DispatchMessage; getUrl: (key: string) => Promise<string> }) {
  const mine = m.direction === 'OUT'
  const note = m.kind === 'NOTE'
  const vm = m.kind === 'VOICEMAIL'
  const delivery = deliveryLabel(m)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', margin: '4px 0' }}>
      <div
        style={{
          maxWidth: 'min(78%, 520px)', padding: '8px 12px', borderRadius: 14,
          borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
          background: note ? 'var(--ds-amber-bg)' : mine ? 'var(--ds-blue)' : 'var(--ds-bg-2)',
          color: note ? 'var(--ds-t1)' : mine ? '#fff' : 'var(--ds-t1)',
          border: note ? '1px dashed var(--ds-amber)' : 'none',
          fontSize: 14, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {note ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ds-amber)', marginBottom: 2 }}><StickyNote className="size-3" /> Internal note · {staffName(m.sentBy)}</div> : null}
        {vm ? (
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ds-t2)' }}><Voicemail className="size-3.5" /> Voicemail · {formatDuration(m.callDurationSec)}</div>
            {m.recordingKey ? <VoicemailPlayer recordingKey={m.recordingKey} getUrl={getUrl} /> : <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Recording unavailable</span>}
            {m.transcript ? <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ds-t2)' }}>“{m.transcript}”</div> : <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Transcript on its way…</div>}
          </div>
        ) : null}
        {!vm && m.body ? <div>{m.body}</div> : null}
        {m.media?.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: m.body ? 6 : 0 }}>
            {m.media.map((md) => <MediaThumb key={md.key} media={md} getUrl={getUrl} />)}
          </div>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
        {mine && !note && m.sentBy ? <span>{staffName(m.sentBy)}</span> : null}
        <span>{bubbleTime(m.at)}</span>
        {delivery ? <span style={{ color: TONE_COLOR[delivery.tone] }}>· {delivery.text}</span> : null}
      </div>
    </div>
  )
}

export function Thread({ conversation, messages, loading, now, canSend, getUrl, onSend, onNote }: Props) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [mode, setMode] = useState<'text' | 'note'>('text')
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastId = messages[messages.length - 1]?.id

  // Follow the bottom when something new lands or the conversation changes.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId, conversation.id])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = body.trim()
    if (sending) return
    if (mode === 'note') {
      if (!text) return
      setSending(true)
      try { await onNote(text); setBody('') } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not save the note') } finally { setSending(false) }
      return
    }
    if (!text && files.length === 0) return
    if (text.length > MAX_SMS_BODY) { toast.error(`Texts are limited to ${MAX_SMS_BODY} characters`); return }
    setSending(true)
    try {
      await onSend(text, files)
      setBody(''); setFiles([])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The text did not send')
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() }
  }

  const pick = (list: FileList | null) => {
    if (!list) return
    const r = acceptFiles(Array.from(list), files.length)
    if (r.rejected.length) toast.error(`Skipped: ${r.rejected.join(', ')}`)
    setFiles((f) => [...f, ...r.ok])
  }

  const groups = groupByDay(messages, now)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
        {loading && messages.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32, color: 'var(--ds-t3)' }}><Loader2 className="size-5 animate-spin" /></div>
        ) : messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, fontSize: 13, color: 'var(--ds-t3)' }}>No messages yet. Say hello below.</div>
        ) : groups.map((g) => (
          <div key={g.key}>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 6px' }}>
              <span style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ds-t3)' }}>{g.label}</span>
            </div>
            {g.messages.map((m) => m.kind === 'CALL' ? <CallRow key={m.id} m={m} /> : <Bubble key={m.id} m={m} getUrl={getUrl} />)}
          </div>
        ))}
      </div>

      <form onSubmit={submit} style={{ borderTop: '1px solid var(--ds-border)', padding: '10px 12px', background: 'var(--ds-surface)' }}>
        {files.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, background: 'var(--ds-bg-2)', borderRadius: 6, padding: '3px 8px' }}>
                <Paperclip className="size-3" /> {f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} style={{ display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)' }}><X className="size-3" /></button>
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button type="button" onClick={() => setMode(mode === 'text' ? 'note' : 'text')} title={mode === 'text' ? 'Switch to an internal note' : 'Switch back to texting'}
              className={cn('inline-flex items-center justify-center rounded-md border size-9')}
              style={{ borderColor: mode === 'note' ? 'var(--ds-amber)' : 'var(--ds-border)', background: mode === 'note' ? 'var(--ds-amber-bg)' : 'transparent', color: mode === 'note' ? 'var(--ds-amber)' : 'var(--ds-t2)' }}>
              <StickyNote className="size-4" />
            </button>
            {mode === 'text' ? (
              <button type="button" onClick={() => fileInput.current?.click()} title="Attach a picture or PDF" disabled={!canSend}
                className="inline-flex items-center justify-center rounded-md border size-9" style={{ borderColor: 'var(--ds-border)', color: 'var(--ds-t2)', opacity: canSend ? 1 : 0.5 }}>
                <Paperclip className="size-4" />
              </button>
            ) : null}
            <input ref={fileInput} type="file" accept={ACCEPTED_MEDIA} multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = '' }} />
          </div>
          <Textarea
            id="dispatch-composer"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === 'note' ? 'Internal note (the driver never sees this)' : canSend ? `Text ${conversation.driverName ?? 'this number'}…` : 'Dispatch is not connected to Twilio yet'}
            disabled={mode === 'text' && !canSend}
            rows={2}
            style={{ flex: 1, resize: 'none', minHeight: 44, maxHeight: 160, background: mode === 'note' ? 'var(--ds-amber-bg)' : undefined }}
          />
          <Button type="submit" size="sm" className="h-9 gap-1.5" disabled={sending || (mode === 'text' && !canSend) || (!body.trim() && files.length === 0)}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : mode === 'note' ? <StickyNote className="size-4" /> : <Send className="size-4" />}
            {mode === 'note' ? 'Save note' : 'Send'}
          </Button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>{mode === 'note' ? 'Notes stay in BCAT Ops.' : 'Enter sends · Shift+Enter for a new line'}</span>
          {mode === 'text' && body.length > 140 ? <span style={{ color: body.length > MAX_SMS_BODY ? 'var(--ds-red)' : undefined }}>{body.length}/{MAX_SMS_BODY}</span> : null}
        </div>
      </form>
    </div>
  )
}
