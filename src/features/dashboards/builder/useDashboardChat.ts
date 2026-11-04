import { useCallback, useRef, useState } from 'react'
import { dashboardChat } from '@/lib/apiClient'
import { CHAT_LIMITS } from '@/lib/dashboards/chatProtocol'
import type {
  DashChatInput,
  DashChatMessage,
  DashChatResult,
  DashboardScope,
  DashboardSpec,
  DashQuestion,
} from '@/lib/dashboards/types'
import { SCOPE_LABEL, scopeSummary } from './scopeLabels'
import type { DashOptions } from '@/lib/dashboards/types'

export interface ChatBubble {
  key: number
  role: 'user' | 'assistant'
  text: string
  questions: DashQuestion[]
  issues: string[]
  /** Set when the provider refused or timed out; the bubble offers Retry. */
  modelError: string | null
}

export const GREETING =
  'Describe the dashboard you want: the metrics, who it is about and the time period. For example "revenue by customer this quarter, with open AR".'

export interface DashboardChat {
  bubbles: ChatBubble[]
  scope: DashboardScope | null
  draft: DashboardSpec | null
  pending: boolean
  /** Transport/validation failure of the last turn (not a model refusal). */
  error: string | null
  canRetry: boolean
  send: (text: string) => void
  /** The ONLY writer of `scope`: called from the scope picker. */
  pickScope: (scope: DashboardScope, options: DashOptions | null) => void
  retry: () => void
  /** Draft changed by the user outside the chat (title edit). */
  setDraft: (spec: DashboardSpec | null) => void
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Owns the transcript, `scope` and `draft`. The server is stateless: every turn sends the whole
 * transcript, the scope and the current draft. `scope` is never derived from typed text.
 */
export function useDashboardChat(initial?: { scope: DashboardScope; draft: DashboardSpec }): DashboardChat {
  const [bubbles, setBubblesState] = useState<ChatBubble[]>([])
  const bubblesRef = useRef<ChatBubble[]>([])
  const [retryable, setRetryable] = useState(false)
  const [scope, setScope] = useState<DashboardScope | null>(initial?.scope ?? null)
  const [draft, setDraft] = useState<DashboardSpec | null>(initial?.draft ?? null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const lastRequest = useRef<DashChatInput | null>(null)
  const keySeq = useRef(0)
  const nextKey = () => ++keySeq.current
  const setBubbles = (next: ChatBubble[]) => {
    bubblesRef.current = next
    setBubblesState(next)
  }

  const run = useCallback((input: DashChatInput) => {
    if (inFlight.current) return
    inFlight.current = true
    lastRequest.current = input
    setPending(true)
    setError(null)
    setRetryable(false)
    dashboardChat(input)
      .then((res: DashChatResult) => {
        setBubbles([
          ...bubblesRef.current,
          {
            key: nextKey(),
            role: 'assistant',
            text: res.reply,
            questions: res.questions,
            issues: res.issues,
            modelError: res.modelError,
          },
        ])
        if (res.spec) setDraft(res.spec)
        if (res.modelError) setRetryable(true)
        else lastRequest.current = null
      })
      .catch((e: unknown) => {
        setError(errText(e))
        setRetryable(true)
      })
      .finally(() => {
        inFlight.current = false
        setPending(false)
      })
  }, [])

  const turn = useCallback(
    (text: string, nextScope: DashboardScope | null, nextDraft: DashboardSpec | null) => {
      if (inFlight.current) return
      const trimmed = text.trim().slice(0, CHAT_LIMITS.maxMessageChars)
      if (!trimmed) return
      const withUser = [
        ...bubblesRef.current,
        { key: nextKey(), role: 'user' as const, text: trimmed, questions: [], issues: [], modelError: null },
      ]
      setBubbles(withUser)
      // The server accepts at most 20 messages: keep the newest, starting on a user turn.
      let messages: DashChatMessage[] = withUser.map((b) => ({ role: b.role, text: b.text })).slice(-CHAT_LIMITS.maxMessages)
      while (messages.length > 1 && messages[0].role !== 'user') messages = messages.slice(1)
      run({ messages, scope: nextScope, draft: nextDraft })
    },
    [run],
  )

  const send = useCallback((text: string) => turn(text, scope, draft), [turn, scope, draft])

  const pickScope = useCallback(
    (next: DashboardScope, options: DashOptions | null) => {
      if (inFlight.current) return
      setScope(next)
      const label = next.kind === 'USERS' || next.kind === 'TEAM' ? scopeSummary(next, options) : SCOPE_LABEL[next.kind]
      turn(`This dashboard is for: ${label}.`, next, draft)
    },
    [turn, draft],
  )

  const retry = useCallback(() => {
    const input = lastRequest.current
    if (!input || inFlight.current) return
    // A model refusal left an assistant bubble behind: drop it, the retry replaces it.
    const last = bubblesRef.current[bubblesRef.current.length - 1]
    if (last?.modelError) setBubbles(bubblesRef.current.slice(0, -1))
    run(input)
  }, [run])

  return {
    bubbles,
    scope,
    draft,
    pending,
    error,
    canRetry: retryable && !pending,
    send,
    pickScope,
    retry,
    setDraft,
  }
}
