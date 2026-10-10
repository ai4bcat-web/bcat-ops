/**
 * Dispatch page state: every conversation, the open thread, and the actions on them.
 *
 * Polling, not subscriptions: the dispatch tables ship without subscription resolvers
 * (CloudFormation cap), and a ten-second list poll plus a four-second thread poll is
 * fast enough for texting. Polls pause while the tab is hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  dispatchAction, listDispatchConversations, listDispatchMessages, uploadDispatchMedia,
} from '@/lib/apiClient'
import { sortThread, type DispatchConversation, type DispatchMessage, type DispatchSettings } from '@/lib/dispatch'

const LIST_POLL_MS = 10_000
const THREAD_POLL_MS = 4_000

export interface DispatchStatus {
  configured: boolean
  dispatchNumber: string | null
  ringing: number
  voicemailEnabled: boolean
  /** Slack bot connected and the per-driver channel bridge switched on. */
  slackBridge?: boolean
}

export interface UseDispatchResult {
  conversations: DispatchConversation[]
  loading: boolean
  error: string | null
  status: DispatchStatus | null
  selectedId: string | null
  select: (id: string | null) => void
  thread: DispatchMessage[]
  threadLoading: boolean
  refresh: () => Promise<void>
  send: (input: { conversationId: string; body: string; files?: File[] }) => Promise<void>
  start: (input: { driverId?: string; phone?: string; displayName?: string }) => Promise<DispatchConversation>
  markRead: (conversationId: string) => Promise<void>
  assign: (conversationId: string, assignedTo: string | null) => Promise<void>
  link: (conversationId: string, input: { driverId?: string; displayName?: string }) => Promise<void>
  setArchived: (conversationId: string, archived: boolean) => Promise<void>
  addNote: (conversationId: string, body: string) => Promise<void>
  mediaUrl: (key: string) => Promise<string>
  createSlackChannel: (conversationId: string, input: { name: string; inviteEmails: string[] }) => Promise<{ conversation: DispatchConversation; url: string | null; notInvited?: string[] }>
  getSettings: () => Promise<DispatchSettings | null>
  saveSettings: (settings: Partial<DispatchSettings>) => Promise<DispatchSettings>
}

function upsert(rows: DispatchConversation[], row: DispatchConversation): DispatchConversation[] {
  const i = rows.findIndex((r) => r.id === row.id)
  if (i === -1) return [...rows, row]
  const next = rows.slice()
  next[i] = row
  return next
}

export function useDispatch(): UseDispatchResult {
  const [conversations, setConversations] = useState<DispatchConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<DispatchStatus | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [thread, setThread] = useState<DispatchMessage[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const selectedRef = useRef<string | null>(null)
  const threadSeq = useRef(0)

  const loadList = useCallback(async () => {
    try {
      const rows = await listDispatchConversations()
      setConversations(rows)
      setError(null)
    } catch (err) {
      console.error('[useDispatch] list failed', err)
      setError(err instanceof Error ? err.message : 'Could not load conversations')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadThread = useCallback(async (id: string | null, showSpinner: boolean) => {
    if (!id) { setThread([]); return }
    const seq = ++threadSeq.current
    if (showSpinner) setThreadLoading(true)
    try {
      const rows = await listDispatchMessages(id)
      if (seq !== threadSeq.current || selectedRef.current !== id) return
      setThread(sortThread(rows))
    } catch (err) {
      console.error('[useDispatch] thread failed', err)
      if (showSpinner) toast.error(err instanceof Error ? err.message : 'Could not load the conversation')
    } finally {
      if (seq === threadSeq.current) setThreadLoading(false)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await dispatchAction<DispatchStatus>('status'))
    } catch (err) {
      console.warn('[useDispatch] status failed', err)
    }
  }, [])

  // First load + polls.
  useEffect(() => {
    const immediate = setTimeout(() => { void loadList(); void refreshStatus() }, 0)
    const tick = () => { if (document.visibilityState === 'visible') void loadList() }
    const t = setInterval(tick, LIST_POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearTimeout(immediate); clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [loadList, refreshStatus])

  useEffect(() => {
    selectedRef.current = selectedId
    const immediate = setTimeout(() => { void loadThread(selectedId, true) }, 0)
    if (!selectedId) return () => clearTimeout(immediate)
    const t = setInterval(() => { if (document.visibilityState === 'visible') void loadThread(selectedId, false) }, THREAD_POLL_MS)
    return () => { clearTimeout(immediate); clearInterval(t) }
  }, [selectedId, loadThread])

  const applyConversation = useCallback((c: DispatchConversation) => setConversations((rows) => upsert(rows, c)), [])

  const refresh = useCallback(async () => {
    await Promise.all([loadList(), loadThread(selectedRef.current, false), refreshStatus()])
  }, [loadList, loadThread, refreshStatus])

  const markRead = useCallback(async (conversationId: string) => {
    const r = await dispatchAction<{ conversation: DispatchConversation }>('markRead', { conversationId })
    applyConversation(r.conversation)
  }, [applyConversation])

  const send = useCallback(async ({ conversationId, body, files }: { conversationId: string; body: string; files?: File[] }) => {
    const mediaKeys: string[] = []
    for (const f of files ?? []) mediaKeys.push(await uploadDispatchMedia(f))
    try {
      const r = await dispatchAction<{ message: DispatchMessage; conversation: DispatchConversation }>('send', { conversationId, body, mediaKeys })
      applyConversation(r.conversation)
      if (selectedRef.current === conversationId) setThread((t) => sortThread([...t.filter((m) => m.id !== r.message.id), r.message]))
    } finally {
      // A refused send still leaves a failed row in the thread worth showing.
      void loadThread(conversationId, false)
    }
  }, [applyConversation, loadThread])

  const start = useCallback(async (input: { driverId?: string; phone?: string; displayName?: string }) => {
    const r = await dispatchAction<{ conversation: DispatchConversation }>('start', input)
    applyConversation(r.conversation)
    return r.conversation
  }, [applyConversation])

  const assign = useCallback(async (conversationId: string, assignedTo: string | null) => {
    const r = await dispatchAction<{ conversation: DispatchConversation }>('assign', { conversationId, assignedTo: assignedTo ?? '' })
    applyConversation(r.conversation)
  }, [applyConversation])

  const link = useCallback(async (conversationId: string, input: { driverId?: string; displayName?: string }) => {
    const r = await dispatchAction<{ conversation: DispatchConversation }>('link', { conversationId, ...input })
    applyConversation(r.conversation)
  }, [applyConversation])

  const setArchived = useCallback(async (conversationId: string, archived: boolean) => {
    const r = await dispatchAction<{ conversation: DispatchConversation }>(archived ? 'archive' : 'reopen', { conversationId })
    applyConversation(r.conversation)
  }, [applyConversation])

  const addNote = useCallback(async (conversationId: string, body: string) => {
    const r = await dispatchAction<{ message: DispatchMessage; conversation: DispatchConversation }>('note', { conversationId, body })
    applyConversation(r.conversation)
    if (selectedRef.current === conversationId) setThread((t) => sortThread([...t, r.message]))
  }, [applyConversation])

  const mediaUrl = useCallback(async (key: string) => (await dispatchAction<{ url: string }>('mediaUrl', { key })).url, [])

  const createSlackChannel = useCallback(async (conversationId: string, input: { name: string; inviteEmails: string[] }) => {
    const r = await dispatchAction<{ conversation: DispatchConversation; url: string | null; notInvited?: string[] }>('createSlackChannel', { conversationId, ...input })
    applyConversation(r.conversation)
    return r
  }, [applyConversation])

  const getSettings = useCallback(async () => (await dispatchAction<{ settings: DispatchSettings | null }>('getSettings')).settings, [])
  const saveSettings = useCallback(async (settings: Partial<DispatchSettings>) => {
    const r = await dispatchAction<{ settings: DispatchSettings }>('saveSettings', settings)
    void refreshStatus()
    return r.settings
  }, [refreshStatus])

  return {
    conversations, loading, error, status, selectedId, select: setSelectedId, thread, threadLoading, refresh,
    send, start, markRead, assign, link, setArchived, addNote, mediaUrl, createSlackChannel, getSettings, saveSettings,
  }
}

/** Unread messages across open conversations, for the sidebar badge. One list every 30 s while visible. */
export function useDispatchUnread(enabled: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const rows = await listDispatchConversations()
        if (alive) setCount(rows.filter((c) => c.status !== 'ARCHIVED').reduce((n, c) => n + Math.max(0, c.unreadCount ?? 0), 0))
      } catch { /* badge is best-effort */ }
    }
    void tick()
    const t = setInterval(tick, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [enabled])
  return count
}
