/**
 * Branding (Step L) — the org's look, senders and e-mail signature.
 *
 * Pure: no store, no clock, no network. Imports are relative because the
 * tmsDirectoryActions Lambda bundles this file by path.
 */
import type { WhiteLabel } from './whiteLabel'

/** The six accent colours the shell supports today. */
export const BRAND_ACCENTS = [
  'YELLOW',
  'BLUE',
  'TEAL',
  'RED',
  'PURPLE',
  'ORANGE',
] as const

export type BrandAccent = (typeof BRAND_ACCENTS)[number]

/** The three theme modes the card offers. Only DARK is actually built. */
export const BRAND_THEMES = ['DARK', 'LIGHT', 'SYSTEM'] as const

export type BrandTheme = (typeof BRAND_THEMES)[number]

/** The five sender slots a team or the org can own. */
export const BRAND_SENDER_SLOTS = [
  'shipment',
  'rateCon',
  'quoteReply',
  'customerInvoice',
  'remittance',
] as const

export type BrandSenderSlot = (typeof BRAND_SENDER_SLOTS)[number]

/** Tokens the signature template may use. */
export const SIGNATURE_TOKENS = [
  'name',
  'title',
  'phone',
  'company',
] as const

export type SignatureToken = (typeof SIGNATURE_TOKENS)[number]

const KNOWN_SIGNATURE_TOKENS: Record<string, true> = {
  name: true,
  title: true,
  phone: true,
  company: true,
}

export interface BrandSenders {
  shipment?: string | null
  rateCon?: string | null
  quoteReply?: string | null
  customerInvoice?: string | null
  remittance?: string | null
}

export interface Branding {
  brandLogoSquareKey?: string | null
  brandLogoWideKey?: string | null
  brandLogoDocumentKey?: string | null
  brandAccent?: BrandAccent | null
  brandTheme?: BrandTheme | null
  brandSenders?: BrandSenders | null
  emailSignatureTemplate?: string | null
  whiteLabel?: WhiteLabel | null
}

const MAX_LOGO_KEY = 300
const MAX_SIGNATURE = 4000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function optionalString(value: unknown, max: number, label: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} is too long.`)
  return trimmed || null
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (!allowed.includes(value as T)) throw new Error(`${label} must be one of ${allowed.join(', ')}.`)
  return value as T
}

/** True when a storage key is safe to accept as a brand logo. */
export function logoKeyOk(key: string | null | undefined): boolean {
  if (!key || typeof key !== 'string') return false
  const trimmed = key.trim()
  if (trimmed.length > MAX_LOGO_KEY) return false
  return trimmed.startsWith('brand/')
}

/** Validator used by SAVE_SETTINGS for the three logo-key fields. */
export function brandKey(value: unknown): string | null {
  const key = optionalString(value, MAX_LOGO_KEY, 'Logo key')
  if (key && !logoKeyOk(key)) {
    throw new Error('Logo keys must start with "brand/" so they cannot be mistaken for documents.')
  }
  return key
}

function validateBrandSenders(value: unknown): BrandSenders | null {
  if (value === null || value === undefined) return null
  const row = asRecord(value)
  if (!row) throw new Error('Sender defaults must be an object.')
  const out: BrandSenders = {}
  for (const slot of BRAND_SENDER_SLOTS) {
    const raw = row[slot]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'string') throw new Error(`The ${slot} sender address must be text.`)
    const address = raw.trim()
    if (address && !EMAIL_RE.test(address)) {
      throw new Error(`"${address}" is not an e-mail address for the ${slot} sender.`)
    }
    if (address) out[slot] = address
  }
  return Object.keys(out).length ? out : null
}

function unknownTokens(template: string): string[] {
  const found: string[] = []
  const seen: Record<string, true> = {}
  for (const match of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    const token = match[1]
    if (KNOWN_SIGNATURE_TOKENS[token] || seen[token]) continue
    seen[token] = true
    found.push(token)
  }
  return found
}

/** Every token in the template that is not a known signature token. */
export function signatureTokens(template: string | null | undefined): string[] {
  if (!template || typeof template !== 'string') return []
  return unknownTokens(template)
}

/** Render a signature template with the user's details. */
export function renderSignature(
  template: string | null | undefined,
  user: { name?: string | null; title?: string | null; phone?: string | null },
  company: { name?: string | null },
): string {
  if (!template || typeof template !== 'string') return ''
  return template
    .replace(/\{name\}/g, user.name ?? '')
    .replace(/\{title\}/g, user.title ?? '')
    .replace(/\{phone\}/g, user.phone ?? '')
    .replace(/\{company\}/g, company.name ?? '')
}

function validateSignatureTemplate(value: unknown): string | null {
  const template = optionalString(value, MAX_SIGNATURE, 'E-mail signature')
  if (!template) return null
  const bad = unknownTokens(template)
  if (bad.length) {
    throw new Error(`Unknown signature token${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}.`)
  }
  return template
}

/**
 * Validate a branding patch from the Company / Branding page.
 * Missing keys are omitted from the result, so a partial save keeps the rest.
 * whiteLabel is validated separately by validateWhiteLabel in whiteLabel.ts.
 */
export function validateBranding(input: unknown): Partial<Branding> {
  const row = asRecord(input)
  if (!row) throw new Error('Branding must be an object.')
  const out: Partial<Branding> = {}

  if ('brandLogoSquareKey' in row) out.brandLogoSquareKey = brandKey(row.brandLogoSquareKey)
  if ('brandLogoWideKey' in row) out.brandLogoWideKey = brandKey(row.brandLogoWideKey)
  if ('brandLogoDocumentKey' in row) out.brandLogoDocumentKey = brandKey(row.brandLogoDocumentKey)

  if ('brandAccent' in row) {
    out.brandAccent = optionalEnum(row.brandAccent, BRAND_ACCENTS, 'Accent colour') as BrandAccent | null
  }
  if ('brandTheme' in row) {
    const theme = optionalEnum(row.brandTheme, BRAND_THEMES, 'Theme') as BrandTheme | null
    if (theme && theme !== 'DARK') {
      throw new Error('Only the dark theme is built; LIGHT and SYSTEM will be available when a second stylesheet exists.')
    }
    out.brandTheme = theme
  }
  if ('brandSenders' in row) out.brandSenders = validateBrandSenders(row.brandSenders)
  if ('emailSignatureTemplate' in row) out.emailSignatureTemplate = validateSignatureTemplate(row.emailSignatureTemplate)

  return out
}
