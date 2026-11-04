/** Step AG S4 test helpers: deps over the memory store, scripted OAuth/sim/objects fakes, item + identity builders. */
import { fxBill, fxExtraction, FX_CARRIER } from '../../../src/lib/apInbox/fixtures'
import type { ApInboxItemRecord } from '../../../src/lib/apInbox/types'
import type { StoredGmailToken } from '../_shared/gmail/tokens'
import type { AppSyncIdentity } from './authorize'
import type { ApInboxDeps } from './contract'
import { createMemoryStore, type MemoryStore, type MemoryStoreSeed } from './memoryStore'

export const NOW = new Date('2026-11-04T15:00:00Z')

export interface Fakes {
  deleted: string[]
  tokens: Map<string, StoredGmailToken>
  revoked: string[]
  injected: unknown[]
  exchange: { refreshToken: string | null; accessToken: string; scope: string; idToken: string | null }
  idEmail: { email: string; emailVerified: boolean }
  scopesOk: boolean
  client: { clientId: string; clientSecret: string; allowedDomain: string } | null
}

export interface Kit {
  mem: MemoryStore
  deps: ApInboxDeps
  fakes: Fakes
}

export function makeKit(seed: MemoryStoreSeed = {}, o: { devStack?: boolean } = {}): Kit {
  const mem = createMemoryStore({ bills: [fxBill()], carriers: [FX_CARRIER], ...seed })
  const fakes: Fakes = {
    deleted: [],
    tokens: new Map(),
    revoked: [],
    injected: [],
    exchange: { refreshToken: 'rt-secret-1', accessToken: 'at', scope: 'https://www.googleapis.com/auth/gmail.readonly', idToken: 'idt' },
    idEmail: { email: 'ai4bcat@gmail.com', emailVerified: true },
    scopesOk: true,
    client: { clientId: 'cid', clientSecret: 'csecret', allowedDomain: '' },
  }
  let n = 0
  const deps: ApInboxDeps = {
    store: mem.store,
    mailboxFor: () => {
      throw new Error('mailbox not used in action tests')
    },
    model: {
      extract: () => {
        throw new Error('model not used in action tests')
      },
    },
    objects: {
      put: async () => undefined,
      delete: async (key) => {
        fakes.deleted.push(key)
      },
    },
    oauth: {
      readClient: async () => fakes.client,
      newState: () => `st${(n += 1)}`,
      buildAuthUrl: (a) => `https://accounts.example/auth?state=${a.state}&login_hint=${a.loginHint}`,
      exchangeCode: async () => fakes.exchange,
      parseIdToken: () => ({ ...fakes.idEmail, hd: null }),
      hasRequiredScopes: () => fakes.scopesOk,
      redirectUriAllowed: (uri, origins) => origins.some((origin) => uri === `${origin}/tms/rates/spot/callback`),
      revoke: async (t) => {
        fakes.revoked.push(t)
      },
      putToken: async (id, rec) => {
        fakes.tokens.set(id, rec)
      },
      getToken: async (id) => fakes.tokens.get(id) ?? null,
      deleteToken: async (id) => {
        fakes.tokens.delete(id)
      },
    },
    sim: {
      inject: async (_u, msg) => {
        fakes.injected.push(msg)
        return { id: msg.id ?? 'sim-1' }
      },
      reset: async () => ({ deleted: 0 }),
      purgeTest: async () => ({ deleted: 0 }),
    },
    now: () => NOW,
    devStack: o.devStack ?? true,
    portalOrigins: ['https://dev.example.com'],
  }
  return { mem, deps, fakes }
}

export function makeItem(over: Partial<ApInboxItemRecord> = {}): ApInboxItemRecord {
  return {
    id: 'apin:m1',
    messageId: 'm1',
    receivedAt: '2026-11-04T10:00:00Z',
    fromEmail: 'billing@swifthaul.example',
    subject: 'Invoice SH-5521',
    kind: 'INVOICE',
    status: 'NEEDS_REVIEW',
    reviewReason: 'LOW_CONFIDENCE',
    extraction: fxExtraction(),
    sourceUrl: 'https://mail.google.com/mail/u/ai4bcat%40gmail.com/#all/m1',
    attachments: [
      { key: 'intake-pdfs/ap-inbox/h1/0-inv.pdf', name: 'inv.pdf', contentType: 'application/pdf', size: 20000 },
      { key: 'intake-pdfs/ap-inbox/h1/email.txt', name: 'email.txt', contentType: 'text/plain', size: 900 },
    ],
    version: 1,
    ...over,
  }
}

export const idOf = (email: string, groups: string[] = []): AppSyncIdentity => ({
  sub: `sub-${email}`,
  username: email,
  claims: { email, 'cognito:groups': groups },
})

export const ADMIN = idOf('admin@bcatcorp.com', ['ADMIN'])
export const OWNER = idOf('ryne@bcatcorp.com')
export const AP_PAY = idOf('pay@bcatcorp.com', ['page-carrierPay'])
export const AP_TMS = idOf('tms@bcatcorp.com', ['page-tms'])
export const NOBODY = idOf('nobody@bcatcorp.com', ['page-quotes'])
