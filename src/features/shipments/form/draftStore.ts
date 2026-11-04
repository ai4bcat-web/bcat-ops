/**
 * Local draft layer (AH-plan §7): nothing is minted on the server until a person asks.
 * `tms:ship-form:draft:<email>:<clientDraftId>`; at most 5 per user (oldest evicted), 30 days,
 * a version bump drops old drafts silently, and a `File` is never serialised.
 */
import type { ShipmentFormValues } from './model'

export const DRAFT_VERSION = 1
export const MAX_DRAFTS = 5
export const DRAFT_TTL_MS = 30 * 86_400_000

export interface StoredDraft { clientDraftId: string; savedAt: string; values: ShipmentFormValues }

const prefix = (email: string): string => `tms:ship-form:draft:${email.toLowerCase()}:`

function store(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function newDraftId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function read(key: string, now: number): StoredDraft | null {
  const s = store()
  if (!s) return null
  try {
    const raw = s.getItem(key)
    if (!raw) return null
    const p = JSON.parse(raw) as { v?: number; savedAt?: string; clientDraftId?: string; values?: ShipmentFormValues }
    if (p.v !== DRAFT_VERSION || !p.values || !p.savedAt || !p.clientDraftId) { s.removeItem(key); return null }
    if (now - Date.parse(p.savedAt) > DRAFT_TTL_MS) { s.removeItem(key); return null }
    return { clientDraftId: p.clientDraftId, savedAt: p.savedAt, values: { ...p.values, docs: { queued: [] } } }
  } catch {
    s.removeItem(key)
    return null
  }
}

export function listDrafts(email: string, now: number = Date.now()): StoredDraft[] {
  const s = store()
  if (!s) return []
  const p = prefix(email)
  const keys: string[] = []
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(p)) keys.push(k) }
  return keys.map((k) => read(k, now)).filter((d): d is StoredDraft => d !== null)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export function loadDraft(email: string, clientDraftId: string): StoredDraft | null {
  return read(prefix(email) + clientDraftId, Date.now())
}

export function deleteDraft(email: string, clientDraftId: string): void {
  store()?.removeItem(prefix(email) + clientDraftId)
}

export function saveDraft(email: string, clientDraftId: string, values: ShipmentFormValues, now: number = Date.now()): void {
  const s = store()
  if (!s) return
  const savedAt = new Date(now).toISOString()
  const payload = { v: DRAFT_VERSION, clientDraftId, savedAt, values: { ...values, docs: { queued: [] } } }
  try {
    s.setItem(prefix(email) + clientDraftId, JSON.stringify(payload))
  } catch (err) {
    console.warn('[shipment form] could not keep the local draft', err)
    return
  }
  const all = listDrafts(email, now)
  for (const d of all.slice(MAX_DRAFTS)) deleteDraft(email, d.clientDraftId)
}
