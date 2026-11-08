import { useEffect, useRef, useState } from 'react'
import { TmsAlert, TmsButton, TmsTextarea } from '@/features/tms/kit'
import { CHAT_LIMITS } from '@/lib/dashboards/chatProtocol'
import type { DashboardAccess, DashOptions, DashboardScope } from '@/lib/dashboards/types'
import { GREETING, type DashboardChat } from './useDashboardChat'
import { ScopePicker } from './ScopePicker'
import { scopeSummary } from './scopeLabels'

export interface ChatPanelProps {
  chat: DashboardChat
  options: DashOptions | null
  access: DashboardAccess
}

export function ChatPanel({ chat, options, access }: ChatPanelProps) {
  const [text, setText] = useState('')
  const [changingScope, setChangingScope] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const { bubbles, scope, pending, error, canRetry } = chat

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [bubbles.length, pending])

  const submit = () => {
    if (pending || !text.trim()) return
    chat.send(text)
    setText('')
  }
  const pick = (next: DashboardScope) => {
    setChangingScope(false)
    chat.pickScope(next, options)
  }
  const lastIndex = bubbles.length - 1

  return (
    <section className="dbb-chat" aria-label="Dashboard assistant">
      <div className="dbb-transcript" data-testid="dash-transcript">
        <div className="dbb-bubble dbb-bubble-assistant">{GREETING}</div>
        {bubbles.map((b, i) => (
          <div key={b.key} className={`dbb-bubble dbb-bubble-${b.role}`}>
            <div>{b.text}</div>
            {b.issues.length > 0 ? (
              <ul className="dbb-issues">
                {b.issues.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
            {b.questions.map((q) =>
              q.kind === 'SCOPE' ? (
                i === lastIndex && scope === null ? (
                  <div key={q.id} className="dbb-question" data-testid="dash-scope-question">
                    <div className="dbb-question-text">{q.text}</div>
                    <ScopePicker value={scope} onChange={pick} options={options} access={access} disabled={pending} />
                  </div>
                ) : null
              ) : (
                <div key={q.id} className="dbb-question">
                  <div className="dbb-question-text">{q.text}</div>
                  {q.choices.length > 0 && i === lastIndex ? (
                    <div className="dbb-chip-row">
                      {q.choices.map((c) => (
                        <button key={c} type="button" className="dbb-chip" disabled={pending} onClick={() => chat.send(c)}>
                          {c}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ),
            )}
            {b.modelError ? (
              <div className="dbb-model-error" data-testid="dash-model-error">
                Model unavailable: {b.modelError}
                <TmsButton size="sm" onClick={chat.retry} disabled={!canRetry}>
                  Retry
                </TmsButton>
              </div>
            ) : null}
          </div>
        ))}
        {pending ? (
          <div className="dbb-bubble dbb-bubble-assistant dbb-thinking" role="status">
            Thinking…
          </div>
        ) : null}
        {error ? (
          <TmsAlert tone="red">
            {error}{' '}
            <TmsButton size="sm" onClick={chat.retry} disabled={!canRetry}>
              Retry
            </TmsButton>
          </TmsAlert>
        ) : null}
        <div ref={endRef} />
      </div>

      {scope ? (
        <div className="dbb-scope-bar" data-testid="dash-scope-bar">
          <span>
            <strong>For:</strong> {scopeSummary(scope, options)}
          </span>
          <TmsButton size="sm" variant="ghost" onClick={() => setChangingScope((v) => !v)} disabled={pending}>
            Change
          </TmsButton>
        </div>
      ) : null}
      {scope && changingScope ? (
        <ScopePicker value={scope} onChange={pick} options={options} access={access} disabled={pending} />
      ) : null}

      <div className="dbb-composer">
        <TmsTextarea
          aria-label="Message"
          placeholder="Describe the dashboard, or ask for a change…"
          rows={3}
          maxLength={CHAT_LIMITS.maxMessageChars}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <TmsButton variant="primary" onClick={submit} disabled={pending || !text.trim()} data-testid="dash-send">
          Send
        </TmsButton>
      </div>
    </section>
  )
}

export default ChatPanel
