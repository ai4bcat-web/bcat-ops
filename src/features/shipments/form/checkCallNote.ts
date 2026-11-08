/**
 * Temperature / Message / EDI Reason ride inside `LoadCheckCall.note` as a first marker line
 * (AH-plan §4.12, D8) so no schema column is needed:  `[ah msg=ON_TIME edi=NS temp=34F]`.
 * A note without the marker decodes to free text only, so legacy and driver-app rows render.
 */
import type { LogCheckCallInput } from '@/lib/apiClient'
import { fromDateTimeInput } from '@/lib/date'
import type { Stop } from '@/types'
import { CHECK_CALL_MESSAGES, MAX } from './constants'
import type { CheckCallDraft } from './sectionProps'

export interface CheckCallNoteFields {
  message?: string
  ediReason?: string
  temperature?: number
  unit?: 'F' | 'C'
  text: string
}

const MARKER = /^\[ah((?: [a-z]+=[^\s\]]+)*)\]\n?/

export function encodeCheckCallNote(f: {
  message?: string; ediReason?: string; temperature?: string | number; unit?: 'F' | 'C'; note: string
}): string {
  const parts: string[] = []
  if (f.message) parts.push(`msg=${f.message}`)
  if (f.ediReason) parts.push(`edi=${f.ediReason}`)
  const t = typeof f.temperature === 'string' ? (f.temperature.trim() === '' ? NaN : Number(f.temperature)) : f.temperature
  if (t !== undefined && Number.isFinite(t)) parts.push(`temp=${Math.round(t as number)}${f.unit ?? 'F'}`)
  const text = f.note.trim()
  const note = parts.length > 0 ? `[ah ${parts.join(' ')}]${text ? `\n${text}` : ''}` : text
  if (note.length > MAX.checkCallNoteTotal) throw new Error(`A check-call note is at most ${MAX.checkCallNoteTotal} characters.`)
  return note
}

export function decodeCheckCallNote(note: string | null | undefined): CheckCallNoteFields {
  const raw = note ?? ''
  const m = MARKER.exec(raw)
  if (!m) return { text: raw }
  const out: CheckCallNoteFields = { text: raw.slice(m[0].length) }
  for (const pair of m[1].trim().split(' ').filter(Boolean)) {
    const [k, v] = pair.split('=')
    if (k === 'msg') out.message = v
    else if (k === 'edi') out.ediReason = v
    else if (k === 'temp') {
      const t = /^(-?\d+)([FC])$/.exec(v)
      if (t) { out.temperature = Number(t[1]); out.unit = t[2] as 'F' | 'C' }
    }
  }
  return out
}

export function messageLabel(code: string | undefined): string {
  if (!code) return ''
  return CHECK_CALL_MESSAGES.find((m) => m.code === code)?.label ?? code
}

/** Build the `LOG_CHECK_CALL` input from the inline row. Throws the server's own words for a future time. */
export function toLogCheckCallInput(
  draft: CheckCallDraft,
  o: { loadId: string; expectedUpdatedAt: string; stops: Stop[]; tempUnit?: 'F' | 'C'; now?: Date },
): LogCheckCallInput {
  const def = CHECK_CALL_MESSAGES.find((m) => m.code === draft.message || m.label === draft.message)
  const now = o.now ?? new Date()
  const at = draft.at ? fromDateTimeInput(draft.at) : now.toISOString()
  if (Date.parse(at) > now.getTime() + 60_000) throw new Error('A check call cannot be logged in the future')
  const stops = [...o.stops].sort((a, b) => a.sequence - b.sequence)
  const stopId = def?.stop === 'first-pickup'
    ? stops.find((s) => s.type === 'pickup')?.id
    : def?.stop === 'last-delivery'
      ? [...stops].reverse().find((s) => s.type === 'delivery')?.id
      : undefined
  const input: LogCheckCallInput = {
    loadId: o.loadId,
    expectedUpdatedAt: o.expectedUpdatedAt,
    at,
    type: def?.type ?? 'NOTE',
    city: draft.city.trim() || null,
    state: draft.state.trim() || null,
    note: encodeCheckCallNote({
      message: def?.code, ediReason: draft.ediReason || undefined,
      temperature: draft.temperature, unit: o.tempUnit, note: draft.note,
    }) || null,
  }
  if (stopId) input.stopId = stopId
  if (def?.incidentType) input.incidentType = def.incidentType
  if (draft.nextAt) input.nextCheckCallAt = fromDateTimeInput(draft.nextAt)
  if (draft.nextNote.trim()) input.nextCheckCallNote = draft.nextNote.trim()
  return input
}
