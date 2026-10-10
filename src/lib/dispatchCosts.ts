/**
 * What the dispatch number costs, from the messages themselves.
 *
 * Twilio bills per SMS segment and per MMS, plus a carrier pass-through fee on every US
 * 10DLC message, plus per-minute voice and the monthly number. Twilio's own invoice is
 * the truth; this is the running estimate at Twilio's published US list rates so the
 * office sees the spend per driver per week without waiting for month end.
 */
import type { DispatchConversation, DispatchMessage } from './dispatch'

/** Dollars. Twilio US list prices as of October 2026; carrier fees are the weighted average. */
export const TWILIO_RATES = {
  smsOutPerSegment: 0.0083,
  smsInPerSegment: 0.0083,
  mmsOut: 0.022,
  mmsIn: 0.01,
  /** 10DLC carrier pass-through, per SMS segment either direction (AT&T 0.002, T-Mobile 0.003, Verizon 0.003). */
  carrierSms: 0.0028,
  /** Per MMS (AT&T 0.0035, T-Mobile 0.01, Verizon 0.005). */
  carrierMms: 0.006,
  /** Inbound call leg, per minute. */
  voiceInPerMin: 0.0085,
  /** The forwarded leg to the dispatcher's phone, per minute. */
  voiceOutPerMin: 0.014,
  /** Voicemail recording storage/transcription: transcription per minute. */
  transcribePerMin: 0.05,
  numberPerMonth: 1.15,
}

/** GSM-7 alphabet; anything outside it (emoji, smart quotes) makes the message UCS-2. */
const GSM7 = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/

/** How many SMS segments a body takes: 160/153 GSM-7 characters, 70/67 UCS-2. */
export function smsSegments(body: string | null | undefined): number {
  const text = body ?? ''
  if (!text) return 1
  const gsm = GSM7.test(text)
  const len = gsm ? [...text].reduce((n, ch) => n + ('^{}\\[~]|€'.includes(ch) ? 2 : 1), 0) : [...text].length
  const single = gsm ? 160 : 70
  const multi = gsm ? 153 : 67
  return len <= single ? 1 : Math.ceil(len / multi)
}

/** Dollars for one message. Notes and status lines are free: they never leave the office. */
export function messageCost(m: Pick<DispatchMessage, 'kind' | 'direction' | 'body' | 'media' | 'status' | 'callDurationSec'>, rates = TWILIO_RATES): number {
  const out = m.direction === 'OUT'
  switch (m.kind) {
    case 'SMS': {
      if (out && (m.status === 'failed' || m.status === 'canceled')) return 0   // never sent
      const seg = smsSegments(m.body)
      return seg * ((out ? rates.smsOutPerSegment : rates.smsInPerSegment) + rates.carrierSms)
    }
    case 'MMS': {
      if (out && (m.status === 'failed' || m.status === 'canceled')) return 0
      const n = Math.max(1, m.media?.length ?? 1)
      return n * ((out ? rates.mmsOut : rates.mmsIn) + rates.carrierMms)
    }
    case 'CALL': {
      const min = Math.ceil((m.callDurationSec ?? 0) / 60)
      // Ringing time is not billed; an answered call pays the inbound leg and the forwarded leg.
      return m.status === 'answered' ? min * (rates.voiceInPerMin + rates.voiceOutPerMin) : 0
    }
    case 'VOICEMAIL': {
      const min = Math.max(1, Math.ceil((m.callDurationSec ?? 0) / 60))
      return min * (rates.voiceInPerMin + rates.transcribePerMin)
    }
    default:
      return 0
  }
}

/** Sunday-start week key (YYYY-MM-DD) for a timestamp, in Chicago time. */
export function weekKeyOf(iso: string): string {
  const d = new Date(iso)
  const chicago = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  chicago.setDate(chicago.getDate() - chicago.getDay())
  const y = chicago.getFullYear(), m = String(chicago.getMonth() + 1).padStart(2, '0'), day = String(chicago.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface WeekCost {
  week: string
  messages: number
  dollars: number
}

export interface DriverCost {
  conversationId: string
  name: string
  phone: string
  weeks: Record<string, WeekCost>
  total: number
  messages: number
}

export interface CostReport {
  /** Week keys, oldest first. */
  weeks: string[]
  drivers: DriverCost[]
  /** Per week across every conversation. */
  weekTotals: Record<string, number>
  grandTotal: number
}

/** The last `weekCount` weeks of spend by conversation. */
export function costReport(conversations: readonly DispatchConversation[], messages: readonly DispatchMessage[], now: Date, weekCount = 8, rates = TWILIO_RATES): CostReport {
  const weeks: string[] = []
  for (let i = weekCount - 1; i >= 0; i -= 1) weeks.push(weekKeyOf(new Date(now.getTime() - i * 7 * 86_400_000).toISOString()))
  const wanted = new Set(weeks)
  const byConv = new Map<string, DriverCost>()
  const titles = new Map(conversations.map((c) => [c.id, c]))
  const weekTotals: Record<string, number> = Object.fromEntries(weeks.map((w) => [w, 0]))
  let grandTotal = 0
  for (const m of messages) {
    const week = weekKeyOf(m.at)
    if (!wanted.has(week)) continue
    const dollars = messageCost(m, rates)
    const c = titles.get(m.conversationId)
    const row = byConv.get(m.conversationId) ?? { conversationId: m.conversationId, name: c?.driverName?.trim() || c?.displayName?.trim() || c?.phone || m.phone, phone: c?.phone ?? m.phone, weeks: {}, total: 0, messages: 0 }
    const wk = row.weeks[week] ?? { week, messages: 0, dollars: 0 }
    const billable = m.kind === 'SMS' || m.kind === 'MMS'
    if (billable) wk.messages += 1
    wk.dollars += dollars
    row.weeks[week] = wk
    row.total += dollars
    if (billable) row.messages += 1
    weekTotals[week] += dollars
    grandTotal += dollars
    byConv.set(m.conversationId, row)
  }
  const drivers = [...byConv.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return { weeks, drivers, weekTotals, grandTotal }
}

/** A rough monthly figure for planning: drivers × messages per week, half each way. */
export function estimateMonthly(drivers: number, messagesPerDriverPerWeek: number, mmsShare = 0.1, rates = TWILIO_RATES): { messaging: number; number: number; total: number } {
  const perMsgSms = rates.smsOutPerSegment + rates.carrierSms   // in and out are priced the same
  const perMsgMms = (rates.mmsOut + rates.mmsIn) / 2 + rates.carrierMms
  const perMsg = (1 - mmsShare) * perMsgSms * 1.1 + mmsShare * perMsgMms   // ~10% of texts run to 2 segments
  const messaging = drivers * messagesPerDriverPerWeek * (52 / 12) * perMsg
  return { messaging, number: rates.numberPerMonth, total: messaging + rates.numberPerMonth }
}
