import { describe, it, expect } from 'vitest'
import {
  phoneDigits, toE164Strict, prettyPhone, samePhone, matchDriverByPhone, conversationTitle,
  messagePreview, sortThread, sortConversations, conversationMatches, normalizeSettings, callPlan,
  DEFAULT_GREETING, DEFAULT_RING_SECONDS, slackChannelNameFor, slackNoteBody,
} from './dispatch'

describe('phones', () => {
  it('reads the ten national digits however the number was typed', () => {
    expect(phoneDigits('(847) 555-0100')).toBe('8475550100')
    expect(phoneDigits('+1 847 555 0100')).toBe('8475550100')
    expect(phoneDigits('18475550100')).toBe('8475550100')
  })
  it('refuses to guess at anything that is not a US number', () => {
    expect(phoneDigits('555-0100')).toBeNull()
    expect(phoneDigits('+44 20 7946 0958')).toBeNull()
    expect(phoneDigits('')).toBeNull()
    expect(toE164Strict('abc')).toBeNull()
  })
  it('formats and compares', () => {
    expect(toE164Strict('847.555.0100')).toBe('+18475550100')
    expect(prettyPhone('+18475550100')).toBe('(847) 555-0100')
    expect(prettyPhone('short')).toBe('short')
    expect(samePhone('+18475550100', '847-555-0100')).toBe(true)
    expect(samePhone('+18475550100', '+18475550101')).toBe(false)
    expect(samePhone('', '')).toBe(false)
  })
})

describe('matchDriverByPhone', () => {
  const drivers = [
    { id: 'old', name: 'Left Company', phone: '(847) 555-0100', active: false },
    { id: 'new', name: 'New Hire', phone: '+18475550100', active: true },
    { id: 'other', name: 'Someone Else', phone: '+13125550199', active: true },
  ]
  it('prefers the active driver when a number was handed down', () => {
    expect(matchDriverByPhone(drivers, '+1 847 555 0100')?.id).toBe('new')
  })
  it('falls back to an inactive driver rather than nobody', () => {
    expect(matchDriverByPhone(drivers, '+13125550199')?.id).toBe('other')
    expect(matchDriverByPhone([drivers[0]], '+18475550100')?.id).toBe('old')
  })
  it('returns null for unknown or malformed numbers', () => {
    expect(matchDriverByPhone(drivers, '+17735550000')).toBeNull()
    expect(matchDriverByPhone(drivers, 'nope')).toBeNull()
  })
})

describe('display', () => {
  it('titles a conversation by driver, then label, then number', () => {
    expect(conversationTitle({ phone: '+18475550100', driverName: 'Jason Smith' })).toBe('Jason Smith')
    expect(conversationTitle({ phone: '+18475550100', displayName: 'Shop (Lyons)' })).toBe('Shop (Lyons)')
    expect(conversationTitle({ phone: '+18475550100' })).toBe('(847) 555-0100')
  })
  it('previews each kind of message', () => {
    expect(messagePreview({ kind: 'SMS', direction: 'IN', body: 'Running 20 late' })).toBe('Running 20 late')
    expect(messagePreview({ kind: 'MMS', direction: 'IN', body: '', media: [{ key: 'a', contentType: 'image/jpeg' }] })).toBe('Photo')
    expect(messagePreview({ kind: 'MMS', direction: 'IN', body: '', media: [{ key: 'a', contentType: 'image/jpeg' }, { key: 'b', contentType: 'image/jpeg' }] })).toBe('2 photos')
    expect(messagePreview({ kind: 'CALL', direction: 'IN', status: 'missed' })).toBe('Missed call')
    expect(messagePreview({ kind: 'CALL', direction: 'IN', status: 'answered', callDurationSec: 95 })).toBe('Call answered (1:35)')
    expect(messagePreview({ kind: 'VOICEMAIL', direction: 'IN', callDurationSec: 34 })).toBe('Voicemail (0:34)')
    expect(messagePreview({ kind: 'VOICEMAIL', direction: 'IN', body: 'Call me back about the trailer' })).toBe('Voicemail: Call me back about the trailer')
    expect(messagePreview({ kind: 'NOTE', direction: 'OUT', body: 'Told him to wait' })).toBe('Note: Told him to wait')
  })
  it('truncates long texts with an ellipsis', () => {
    const long = 'x'.repeat(150)
    expect(messagePreview({ kind: 'SMS', direction: 'IN', body: long }).length).toBe(100)
    expect(messagePreview({ kind: 'SMS', direction: 'IN', body: long }).endsWith('…')).toBe(true)
  })
})

describe('ordering', () => {
  it('reads a thread oldest first', () => {
    const t = sortThread([{ id: 'b', at: '2026-10-10T12:00:00Z' }, { id: 'a', at: '2026-10-10T11:00:00Z' }])
    expect(t.map((m) => m.id)).toEqual(['a', 'b'])
  })
  it('puts unread conversations first, then most recent', () => {
    const rows = sortConversations([
      { id: 'quiet-new', unreadCount: 0, lastMessageAt: '2026-10-10T12:00:00Z' },
      { id: 'unread-old', unreadCount: 2, lastMessageAt: '2026-10-09T12:00:00Z' },
      { id: 'quiet-old', unreadCount: 0, lastMessageAt: '2026-10-08T12:00:00Z' },
      { id: 'never', unreadCount: 0, createdAt: '2026-10-11T12:00:00Z' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['unread-old', 'never', 'quiet-new', 'quiet-old'])
  })
  it('searches by name, digits and assignee', () => {
    const c = { id: '1', phone: '+18475550100', driverName: 'Jason Smith', assignedTo: 'jenny@bcatcorp.com', lastPreview: 'at the dock' }
    expect(conversationMatches(c, 'jason')).toBe(true)
    expect(conversationMatches(c, '555-01')).toBe(true)
    expect(conversationMatches(c, 'jenny')).toBe(true)
    expect(conversationMatches(c, 'dock')).toBe(true)
    expect(conversationMatches(c, 'ruben')).toBe(false)
    expect(conversationMatches(c, '')).toBe(true)
  })
})

describe('settings', () => {
  it('normalises phones, drops duplicates and fills defaults', () => {
    const r = normalizeSettings({ forwardTo: [{ name: 'Ryne', phone: '847-555-0100' }, { name: 'dup', phone: '+18475550100' }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.forwardTo).toEqual([{ name: 'Ryne', phone: '+18475550100' }])
    expect(r.value.ringSeconds).toBe(DEFAULT_RING_SECONDS)
    expect(r.value.voicemailEnabled).toBe(true)
    expect(r.value.greeting).toBeNull()
  })
  it('rejects a bad forward number, out-of-range ring time, and a malformed Slack id', () => {
    expect(normalizeSettings({ forwardTo: [{ name: 'x', phone: '12' }] })).toMatchObject({ ok: false, problem: { field: 'forwardTo' } })
    expect(normalizeSettings({ ringSeconds: 3 })).toMatchObject({ ok: false, problem: { field: 'ringSeconds' } })
    expect(normalizeSettings({ slackChannelId: 'general' })).toMatchObject({ ok: false, problem: { field: 'slackChannelId' } })
    expect(normalizeSettings({ slackChannelId: 'C0123ABCDEF' })).toMatchObject({ ok: true })
  })
  it('builds a call plan with the default greeting when none is written', () => {
    const plan = callPlan({ forwardTo: [{ name: 'Ryne', phone: '+18475550100' }], ringSeconds: 20 })
    expect(plan.ring).toHaveLength(1)
    expect(plan.ringSeconds).toBe(20)
    expect(plan.voicemail).toBe(true)
    expect(plan.greeting).toBe(DEFAULT_GREETING)
    expect(callPlan(null).ring).toEqual([])
  })
})

describe('slack bridge helpers', () => {
  it('names a channel after the driver, else the label, else the number', () => {
    expect(slackChannelNameFor({ phone: '+18475550100', driverName: 'Jason Smith' })).toBe('drv-jason-smith')
    expect(slackChannelNameFor({ phone: '+18475550100', displayName: "Lyons Truck Parts (Chi)" })).toBe('drv-lyons-truck-parts-chi')
    expect(slackChannelNameFor({ phone: '+18475550100' })).toBe('drv-847-555-0100')
    expect(slackChannelNameFor({ phone: '+18475550100', driverName: 'José Núñez' })).toBe('drv-jose-nunez')
  })
  it('treats // messages as internal notes', () => {
    expect(slackNoteBody('// told him to wait')).toBe('told him to wait')
    expect(slackNoteBody('  //   ')).toBeNull()
    expect(slackNoteBody('on my way')).toBeNull()
  })
  it('normalises the Slack settings', () => {
    const r = normalizeSettings({ slackInviteEmails: ['Ryne@bcatcorp.com', ' jenny@bcatcorp.com ', 'ryne@bcatcorp.com'], slackMirror: false })
    expect(r.ok && r.value.slackInviteEmails).toEqual(['ryne@bcatcorp.com', 'jenny@bcatcorp.com'])
    expect(r.ok && r.value.slackMirror).toBe(false)
    expect(normalizeSettings({}).ok && (normalizeSettings({}) as { ok: true; value: { slackMirror: boolean } }).value.slackMirror).toBe(true)
    expect(normalizeSettings({ slackInviteEmails: ['not an email'] })).toMatchObject({ ok: false, problem: { field: 'slackInviteEmails' } })
  })
})
