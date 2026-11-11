import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Send } from 'lucide-react'
import { TmsAlert, TmsButton, TmsTextarea } from '@/features/tms/kit'
import { askAssistant } from '@/lib/apiClient'
import { parseMarkdown, type MdBlock, type MdSpan } from '@/features/tms/pages/academyMarkdown'
import { ASSISTANT_GREETING, ASSISTANT_SUGGESTIONS } from './assistantCopy'
import './assistant.css'

const LOOKUP_LABEL: Record<string, string> = { run_query: 'Looked up business data', find_shipment: 'Looked up a shipment' }

interface Bubble {
  key: number
  role: 'user' | 'assistant'
  text: string
  lookups: string[]
}

/** Spans as text only: the model's output never becomes a link. */
function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        let node: ReactNode = s.text
        if (s.code) node = <code>{node}</code>
        if (s.bold) node = <strong>{node}</strong>
        if (s.italic) node = <em>{node}</em>
        return <Fragment key={i}>{node}</Fragment>
      })}
    </>
  )
}

function Blocks({ blocks }: { blocks: MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <p key={i} className="ast-h"><Spans spans={b.spans} /></p>
          case 'paragraph':
            return <p key={i}><Spans spans={b.spans} /></p>
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return <Tag key={i}>{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</Tag>
          }
          case 'code':
            return <pre key={i}>{b.text}</pre>
          case 'table':
            return (
              <div key={i} className="ast-table">
                <table>
                  <thead><tr>{b.header.map((h, j) => <th key={j}><Spans spans={h} /></th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Spans spans={c} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            )
        }
      })}
    </>
  )
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The "Ask" tab: a stateless chat. Every turn sends the whole transcript; the server enforces who may see what. */
export function AssistantChat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keySeq = useRef(0)
  const inFlight = useRef(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const [lastSent, setLastSent] = useState<Bubble[] | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [bubbles.length, pending])

  const run = (history: Bubble[]) => {
    if (inFlight.current) return
    inFlight.current = true
    setLastSent(history)
    setPending(true)
    setError(null)
    askAssistant(history.map((b) => ({ role: b.role, text: b.text })))
      .then((res) => {
        if (res.modelError) {
          setError(res.modelError)
          return
        }
        setBubbles([...history, { key: ++keySeq.current, role: 'assistant', text: res.reply, lookups: res.toolsUsed }])
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => {
        inFlight.current = false
        setPending(false)
      })
  }

  const send = (raw: string) => {
    const t = raw.trim()
    if (!t || pending) return
    const next = [...bubbles, { key: ++keySeq.current, role: 'user' as const, text: t, lookups: [] }]
    setBubbles(next)
    setText('')
    run(next)
  }

  return (
    <section className="ast" aria-label="Ask BCAT" data-testid="assistant">
      <div className="ast-transcript" data-testid="assistant-transcript">
        <div className="ast-bubble ast-bubble-assistant">{ASSISTANT_GREETING}</div>
        {bubbles.length === 0 ? (
          <div className="ast-chips">
            {ASSISTANT_SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="ast-chip" disabled={pending} onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        ) : null}
        {bubbles.map((b) => (
          <div key={b.key} className={`ast-bubble ast-bubble-${b.role}`}>
            {b.role === 'assistant' ? <Blocks blocks={parseMarkdown(b.text)} /> : b.text}
            {b.lookups.length > 0 ? (
              <div className="ast-lookups">{[...new Set(b.lookups)].map((l) => LOOKUP_LABEL[l] ?? l).join(' · ')}</div>
            ) : null}
          </div>
        ))}
        {pending ? <div className="ast-bubble ast-bubble-assistant ast-thinking" role="status">Looking that up…</div> : null}
        {error ? (
          <TmsAlert tone="red">
            {error}{' '}
            {lastSent ? <TmsButton size="sm" onClick={() => run(lastSent)} disabled={pending}>Retry</TmsButton> : null}
          </TmsAlert>
        ) : null}
        <div ref={endRef} />
      </div>
      <form
        className="ast-composer"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <TmsTextarea
          aria-label="Ask a question"
          placeholder="Ask about shipments, revenue, receivables, quotes…"
          rows={2}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(text)
            }
          }}
        />
        <TmsButton type="submit" variant="primary" disabled={pending || !text.trim()}>
          <Send size={16} aria-hidden="true" /> Ask
        </TmsButton>
      </form>
    </section>
  )
}

export default AssistantChat
