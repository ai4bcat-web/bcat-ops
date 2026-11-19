/**
 * Carrier bank details (routing + account number) for the Chase ACH export.
 *
 * Same protection as the carrier tax-ID vault (`taxVault.ts`), on the same KMS key: the number only ever
 * exists in clear inside a Lambda, between validation and `kms:Encrypt`, or between `kms:Decrypt` and the
 * file the export builds. What is stored is a KMS ciphertext bound to the carrier by encryption context
 * (`field: bankAccount`), written straight to DynamoDB on the CarrierPaymentMethod item under `bankCipher`.
 * `bankCipher` is NOT in the GraphQL schema: no AppSync type or query can carry it, so a browser can not read it
 * even by asking. The item's declared mirror fields (`accountLast4`, `routingLast4`, `bankDetailsOnFileAt`,
 * `bankAccountType`) are all a screen ever sees.
 *
 * Keys are the vault's (`alias/bcat-tax-vault-<apiId>`); the key policy decides who may use them for this field:
 * carrier-actions and mcp-sync may Encrypt, only finance-actions may Decrypt (backend.ts, vault stack).
 *
 * Nothing in here may log, throw or audit a number. Errors are fixed sentences.
 */
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms'
import { vaultNamesFor } from './taxVault'
import { isValidRoutingNumber, type NachaAccountType } from './nacha'

export type BankDetailsSource = 'MANUAL' | 'MCP'

/** A failure whose message is safe to show anyone: it never carries a number. */
export class BankVaultError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'BankVaultError'
  }
}

export interface BankVaultDeps {
  kms: Pick<KMSClient, 'send'>
  carrierTable: string
}

export function bankVaultDepsFromEnv(kms: Pick<KMSClient, 'send'> = new KMSClient({})): BankVaultDeps {
  return { kms, carrierTable: process.env.CARRIER_TABLE_NAME ?? '' }
}

export interface BankDetailsInput {
  routingNumber: unknown
  accountNumber: unknown
  accountType?: unknown
}

export interface NormalizedBankDetails {
  routingNumber: string
  accountNumber: string
  accountType: NachaAccountType
  routingLast4: string
  accountLast4: string
}

export interface BankDetailsPlain {
  routingNumber: string
  accountNumber: string
  accountType: NachaAccountType
}

/** Digits only, 4 to 17 of them, a real ABA routing number. Anything else is refused with a fixed sentence. */
export function normalizeBankDetails(input: BankDetailsInput): NormalizedBankDetails {
  const routing = typeof input.routingNumber === 'string' ? input.routingNumber.replace(/[\s-]/g, '') : ''
  const account = typeof input.accountNumber === 'string' ? input.accountNumber.replace(/[\s-]/g, '') : ''
  if (!/^\d{9}$/.test(routing)) throw new BankVaultError('The routing number must be exactly 9 digits', 'INVALID_ROUTING')
  if (!isValidRoutingNumber(routing)) throw new BankVaultError('That routing number fails the check-digit test; re-check it', 'INVALID_ROUTING')
  if (!/^\d{4,17}$/.test(account)) throw new BankVaultError('The account number must be 4 to 17 digits', 'INVALID_ACCOUNT')
  const type = input.accountType == null || input.accountType === '' ? 'CHECKING' : input.accountType
  if (type !== 'CHECKING' && type !== 'SAVINGS') throw new BankVaultError('Account type must be checking or savings', 'INVALID_TYPE')
  return { routingNumber: routing, accountNumber: account, accountType: type, routingLast4: routing.slice(-4), accountLast4: account.slice(-4) }
}

export function bankContext(deps: BankVaultDeps, carrierId: string): Record<string, string> {
  return { carrierId, field: 'bankAccount', api: vaultNamesFor(deps.carrierTable).apiId }
}

/** The ciphertext for one payment method's numbers, bound to the carrier and to the method. */
export async function encryptBankDetails(
  deps: BankVaultDeps,
  ids: { carrierId: string; methodId: string },
  details: NormalizedBankDetails,
): Promise<Uint8Array> {
  const names = vaultNamesFor(deps.carrierTable)
  const plaintext = JSON.stringify({ v: 1, m: ids.methodId, r: details.routingNumber, a: details.accountNumber, t: details.accountType })
  const out = await deps.kms.send(new EncryptCommand({
    KeyId: names.keyId,
    Plaintext: Buffer.from(plaintext, 'utf8'),
    EncryptionContext: bankContext(deps, ids.carrierId),
  }))
  if (!out.CiphertextBlob) throw new BankVaultError('Bank details store unavailable', 'KMS')
  return out.CiphertextBlob
}

/** Clear numbers, only for building the export file. A ciphertext bound to another method or carrier fails. */
export async function decryptBankDetails(
  deps: BankVaultDeps,
  ids: { carrierId: string; methodId: string },
  ciphertext: Uint8Array,
): Promise<BankDetailsPlain> {
  let parsed: unknown
  try {
    const out = await deps.kms.send(new DecryptCommand({ CiphertextBlob: ciphertext, EncryptionContext: bankContext(deps, ids.carrierId) }))
    if (!out.Plaintext) throw new Error('empty')
    parsed = JSON.parse(Buffer.from(out.Plaintext).toString('utf8'))
  } catch {
    throw new BankVaultError('Bank details could not be read', 'KMS')
  }
  const p = parsed as { m?: unknown; r?: unknown; a?: unknown; t?: unknown } | null
  if (!p || p.m !== ids.methodId || typeof p.r !== 'string' || typeof p.a !== 'string') {
    throw new BankVaultError('Bank details do not belong to this payment method', 'MISMATCH')
  }
  return { routingNumber: p.r, accountNumber: p.a, accountType: p.t === 'SAVINGS' ? 'SAVINGS' : 'CHECKING' }
}

/** Last-resort scrub for any free text that could have come from a person. */
export function redactBankNumbers(text: string): string {
  return text.replace(/\b\d{6,17}\b/g, '[redacted]')
}
