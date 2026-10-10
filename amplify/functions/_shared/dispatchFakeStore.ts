/**
 * In-memory stand-in for DispatchStore, for the dispatch Lambda tests. Same method
 * surface, same conditional-write semantics where they matter (duplicate ids, missing rows).
 */
import { randomUUID } from 'node:crypto'
import type { DispatchConversation, DispatchDriver, DispatchMessage, DispatchSettings } from '../../../src/lib/dispatch'
import { messagePreview } from '../../../src/lib/dispatch'
import type { DispatchStore } from './dispatchStore'

export class FakeDispatchStore {
  conversations = new Map<string, DispatchConversation>()
  messages = new Map<string, DispatchMessage>()
  settings: DispatchSettings | null = null
  drivers: DispatchDriver[] = []
  clock = () => '2026-10-10T15:00:00.000Z'

  asStore(): DispatchStore { return this as unknown as DispatchStore }

  async findConversationByPhone(phone: string) {
    return [...this.conversations.values()].filter((c) => c.phone === phone).sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1))[0] ?? null
  }
  async getConversation(id: string) { return this.conversations.get(id) ?? null }
  async findConversationBySlackChannel(channelId: string) { return [...this.conversations.values()].find((c) => c.slackChannelId === channelId) ?? null }
  async createConversation(input: { phone: string; driverId?: string | null; driverName?: string | null; displayName?: string | null }) {
    const now = this.clock()
    const row: DispatchConversation = { id: randomUUID(), phone: input.phone, driverId: input.driverId ?? null, driverName: input.driverName ?? null, displayName: input.displayName ?? null, status: 'OPEN', unreadCount: 0, lastMessageAt: null, lastPreview: null, lastDirection: null, lastKind: null, assignedTo: null, createdAt: now, updatedAt: now }
    this.conversations.set(row.id, row)
    return row
  }
  async ensureConversation(phone: string, drivers: readonly DispatchDriver[], match: (d: readonly DispatchDriver[], p: string) => DispatchDriver | null) {
    const existing = await this.findConversationByPhone(phone)
    if (existing) return { conversation: existing, created: false }
    const driver = match(drivers, phone)
    return { conversation: await this.createConversation({ phone, driverId: driver?.id ?? null, driverName: driver?.name ?? null }), created: true }
  }
  async updateConversation(id: string, patch: { set?: Partial<DispatchConversation>; unreadDelta?: number; unreadTo?: number }) {
    const c = this.conversations.get(id)
    if (!c) throw Object.assign(new Error('ConditionalCheckFailed'), { name: 'ConditionalCheckFailedException' })
    const next: DispatchConversation = { ...c, ...(patch.set ?? {}), updatedAt: this.clock() }
    if (patch.unreadTo !== undefined) next.unreadCount = patch.unreadTo
    else if (patch.unreadDelta) next.unreadCount = (c.unreadCount ?? 0) + patch.unreadDelta
    this.conversations.set(id, next)
    return next
  }
  async touchConversation(id: string, message: DispatchMessage, opts: { unread: 'increment' | 'clear' | 'keep' }) {
    return this.updateConversation(id, {
      set: { lastMessageAt: message.at, lastPreview: messagePreview(message), lastDirection: message.direction, lastKind: message.kind, lastSentBy: message.direction === 'OUT' ? (message.sentBy ?? null) : null, status: 'OPEN' },
      unreadDelta: opts.unread === 'increment' ? 1 : undefined,
      unreadTo: opts.unread === 'clear' ? 0 : undefined,
    })
  }
  async listConversations() { return [...this.conversations.values()] }
  async putMessage(input: Omit<DispatchMessage, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) {
    const now = this.clock()
    const row: DispatchMessage = { id: input.id ?? randomUUID(), ...input, createdAt: now, updatedAt: now }
    if (this.messages.has(row.id)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' })
    this.messages.set(row.id, row)
    return row
  }
  async findMessageByTwilioSid(sid: string) { return [...this.messages.values()].find((m) => m.twilioSid === sid) ?? null }
  async getMessage(id: string) { return this.messages.get(id) ?? null }
  async findMessageBySlackTs(ts: string) { return [...this.messages.values()].find((m) => m.slackTs === ts) ?? null }
  async updateMessage(id: string, set: Partial<DispatchMessage>) {
    const m = this.messages.get(id)
    if (!m) throw new Error('missing message')
    const next = { ...m, ...set, updatedAt: this.clock() }
    this.messages.set(id, next)
    return next
  }
  async listMessages(conversationId: string, _limit = 500) { return [...this.messages.values()].filter((m) => m.conversationId === conversationId).sort((a, b) => (a.at < b.at ? -1 : 1)) }
  async getSettings() { return this.settings }
  async putSettings(value: DispatchSettings) { this.settings = { id: 'default', ...value, updatedAt: this.clock() }; return this.settings }
  async listDrivers() { return this.drivers }
}
