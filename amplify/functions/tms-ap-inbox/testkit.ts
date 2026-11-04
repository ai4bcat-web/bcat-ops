/**
 * Step AG S3 test helpers: `ApInboxDeps` over the memory store, the real SIM mailbox over an
 * in-memory S3, an in-memory object store and a scripted model.
 */
import type { RawApModelOutput } from '../../../src/lib/apInbox/normalize'
import { simInject, simPort, type SimInboxMessage, type SimS3 } from '../_shared/gmail/simPort'
import { makeKit, NOW, type Kit } from './actionsTestkit'
import type { ApInboxDeps, ApModelInput } from './contract'
import type { MemoryStoreSeed } from './memoryStore'

export { NOW }

export type MemSimS3 = SimS3 & { files: Map<string, string> }

export function memSimS3(): MemSimS3 {
  const files = new Map<string, string>()
  return {
    files,
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => {
      files.set(key, body)
    },
    del: async (key) => {
      files.delete(key)
    },
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)),
  }
}

/** A clean carrier invoice as the model would answer it (sentinels, not nulls). */
export function rawInvoice(over: Partial<RawApModelOutput> = {}): RawApModelOutput {
  return {
    kind: 'INVOICE',
    confidence: 'high',
    reason: 'Carrier invoice',
    issuerName: 'Swift Haul LLC',
    issuerKind: 'CARRIER',
    mcNumber: '123456',
    dotNumber: '',
    proNumbers: ['S000101-1'],
    otherRefs: [],
    invoiceNumber: 'SH-5521',
    invoiceDate: '2026-11-03',
    dueDate: '2026-12-03',
    termsDays: 30,
    amountDollars: 1500.5,
    remitToName: '',
    remitToText: '',
    notes: '',
    lowConfidence: [],
    ...over,
  }
}

export const rawOther = (kind: string): RawApModelOutput =>
  rawInvoice({ kind, issuerName: '', mcNumber: '', proNumbers: [], invoiceNumber: '', invoiceDate: '', dueDate: '', termsDays: -1, amountDollars: -1 })

export const pdf = (name: string, size = 20_000): NonNullable<SimInboxMessage['attachments']>[number] => ({
  name,
  contentType: 'application/pdf',
  size,
  dataBase64: Buffer.from('%PDF-1.4 synthetic invoice').toString('base64'),
})

export const hoursAgo = (h: number): string => String(NOW.getTime() - h * 3_600_000)

export interface SyncKit extends Kit {
  s3: MemSimS3
  /** Objects the Lambda wrote (key -> body). */
  objects: Map<string, Buffer | string>
  /** Every input the model was called with. */
  modelCalls: ApModelInput[]
  inject(msg: SimInboxMessage): Promise<{ id: string }>
}

/**
 * `model` answers each call; without one any call is a test bug and throws.
 * Config defaults to enabled + SIMULATED on a dev stack.
 */
export function makeSyncKit(
  seed: MemoryStoreSeed = {},
  o: { model?: (input: ApModelInput) => RawApModelOutput | Promise<RawApModelOutput>; devStack?: boolean } = {},
): SyncKit {
  const kit = makeKit({ ...seed, config: { enabled: true, mode: 'SIMULATED', ...seed.config } }, { devStack: o.devStack })
  const s3 = memSimS3()
  const objects = new Map<string, Buffer | string>()
  const modelCalls: ApModelInput[] = []
  const mailbox = simPort('ap-inbox', s3)
  const deps: ApInboxDeps = kit.deps
  deps.mailboxFor = () => mailbox
  deps.model = {
    extract: async (input) => {
      modelCalls.push(input)
      if (!o.model) throw new Error(`unscripted model call: ${input.subject}`)
      return o.model(input)
    },
  }
  deps.objects = {
    put: async (key, body) => {
      objects.set(key, body)
    },
    delete: async (key) => {
      objects.delete(key)
    },
  }
  return { ...kit, s3, objects, modelCalls, inject: (msg) => simInject('ap-inbox', msg, s3) }
}
