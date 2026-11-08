import { describe, expect, it } from 'vitest'
import type { GmailMessageMeta } from '../spot/port'
import { authOkFromHeaders, prefilterStage1, prefilterStage2, prepareInboundBody } from './prefilter'
import { DEFAULT_CARRIER_INBOX_CONFIG } from './settings'
import type { CarrierInboxMailbox } from './types'

const mailbox: CarrierInboxMailbox = {
  id: 'm1', label: 'Loads', account: 'ai4bcat@gmail.com', addresses: ['loads@example.invalid'], gmailLabel: null, mode: 'GOOGLE', paused: false,
}
const cfg = { ...DEFAULT_CARRIER_INBOX_CONFIG, mailboxes: [mailbox], ignoreSenders: ['spam.example.invalid'] }
const none = { addresses: [] as string[], keywords: [] as string[] }
const meta = (over: Partial<GmailMessageMeta> = {}): GmailMessageMeta => ({
  id: 'g1', threadId: 't1', internalDate: '1', from: 'Dana <dana@carrier.example.invalid>', to: ['loads@example.invalid'], cc: [],
  replyTo: null, subject: 'Load ZZ1001', messageId: '<m1>', inReplyTo: null, references: null, snippet: 'truck', labelIds: ['INBOX'], headers: {}, ...over,
})
const s1 = (over: Partial<GmailMessageMeta> = {}, bl = none, box = mailbox) => prefilterStage1(meta(over), { ...cfg, mailboxes: [box] }, box, bl)

describe('stage 1', () => {
  it('passes mail addressed to the distribution address, including plus and Delivered-To forms', () => {
    expect(s1().pass).toBe(true)
    expect(s1({ to: ['Loads+bids.ZZ1001@example.invalid'] }).pass).toBe(true)
    expect(s1({ to: ['group@example.invalid'], headers: { 'delivered-to': 'loads@example.invalid' } }).pass).toBe(true)
    expect(s1({ to: ['other@example.invalid'], cc: [] })).toMatchObject({ pass: false, reason: 'WRONG_MAILBOX' })
  })
  it('passes by Gmail label when the address is hidden by a forward', () => {
    const box = { ...mailbox, addresses: [], gmailLabel: 'Label_9' }
    expect(s1({ to: [], labelIds: ['INBOX', 'Label_9'] }, none, box).pass).toBe(true)
    expect(s1({ to: [], labelIds: ['INBOX'] }, none, box).pass).toBe(false)
  })
  it('a mailbox with no address and no label reads nothing', () => {
    expect(s1({}, none, { ...mailbox, addresses: [] }).pass).toBe(false)
  })
  it('drops drafts, sent, spam, auto-submitted, bulk, list mail and promotional categories', () => {
    for (const over of [
      { labelIds: ['SENT'] }, { labelIds: ['SPAM'] }, { headers: { 'auto-submitted': 'auto-replied' } },
      { headers: { precedence: 'bulk' } }, { headers: { 'list-unsubscribe': '<x>' } }, { labelIds: ['CATEGORY_PROMOTIONS'] },
      { from: 'noreply@carrier.example.invalid' }, { from: 'mailer-daemon@x.example.invalid' },
    ]) expect(s1(over).pass).toBe(false)
    expect(s1({ headers: { 'auto-submitted': 'no' } }).pass).toBe(true)
  })
  it('lets a load-board relay through the bulk rules and names the provider', () => {
    const v = s1({ from: 'bids@dat.com', headers: { precedence: 'bulk', 'list-unsubscribe': '<x>' }, labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] })
    expect(v).toEqual({ pass: true, boardProvider: 'DAT' })
    expect(s1({ from: 'noreply@mail.truckstop.com' })).toEqual({ pass: true, boardProvider: 'TRUCKSTOP' })
    expect(s1({ from: 'mailer-daemon@dat.com' }).pass).toBe(false)
  })
  it('keeps own-domain senders but drops our own mailbox and distribution address', () => {
    expect(s1({ from: 'rep@bcatcorp.com' }).pass).toBe(true)
    expect(s1({ from: 'ai4bcat@gmail.com' })).toMatchObject({ pass: false, reason: 'OWN_MAILBOX' })
    expect(s1({ from: 'loads@example.invalid' })).toMatchObject({ pass: false, reason: 'OWN_MAILBOX' })
  })
  it('applies ignore senders and the org blacklist', () => {
    expect(s1({ from: 'x@spam.example.invalid' })).toMatchObject({ pass: false, reason: 'BLACKLIST' })
    expect(s1({ from: 'x@bad.example.invalid' }, { addresses: ['@bad.example.invalid'], keywords: [] }).pass).toBe(false)
    expect(s1({ subject: 'crypto deal' }, { addresses: [], keywords: ['crypto'] }).pass).toBe(false)
  })
})

describe('stage 2', () => {
  const pass = (text: string, boardRelay = false) => prefilterStage2(text, { boardRelay }).pass
  it('price + reference / MC / lane passes', () => {
    expect(pass('Load ZZAL1001 for $1,850')).toBe(true)
    expect(pass('We can do $1,500. MC 654321')).toBe(true)
    expect(pass('Joliet, IL to Fort Wayne, IN for $1,650')).toBe(true)
    expect(pass('$5 on load ZZAL1004')).toBe(true)
  })
  it('reference + carrier cue passes without a price', () => {
    expect(pass('Interested in load ZZAL1004, truck available Thursday')).toBe(true)
  })
  it('fails when there is a price but nothing to tie it to, or chatter', () => {
    expect(pass('Great quarter! Revenue was $4,000,000.')).toBe(false)
    expect(pass('Thanks, see you Thursday.')).toBe(false)
    expect(pass('Reference ZZAL1001 attached for your records.')).toBe(false)
  })
  it('a board relay passes on sender alone', () => {
    expect(pass('A new bid arrived', true)).toBe(true)
  })
})

describe('prepareInboundBody', () => {
  const body = 'We can do $1,500 on ZZ1001\n> old load ZZ0001 $900\n-- \nDana'
  it('strips quoted history from a reply', () => {
    expect(prepareInboundBody('Re: Load ZZ1001', body)).toBe('We can do $1,500 on ZZ1001')
  })
  it('keeps a forward intact, the carrier words are in the quoted part', () => {
    const fwd = 'FYI\n---------- Forwarded message ----------\nWe can haul it for $2,100'
    expect(prepareInboundBody('Fwd: Load ZZ1001', fwd)).toContain('$2,100')
    expect(prepareInboundBody('FW: Load', fwd)).toContain('$2,100')
    expect(prepareInboundBody('Load', fwd)).not.toContain('$2,100')
  })
})

describe('authOkFromHeaders', () => {
  it('requires a pass aligned with the From domain', () => {
    const ok = 'mx; spf=pass smtp.mailfrom=carrier.example.invalid; dkim=pass header.d=carrier.example.invalid'
    expect(authOkFromHeaders({ 'authentication-results': ok }, 'Dana <dana@carrier.example.invalid>')).toBe(true)
    expect(authOkFromHeaders({ 'authentication-results': ok }, 'x@other.example.invalid')).toBe(false)
    expect(authOkFromHeaders({}, 'x@carrier.example.invalid')).toBe(false)
  })
})
