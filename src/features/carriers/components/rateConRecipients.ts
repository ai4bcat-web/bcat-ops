/**
 * Pure helpers behind the rate-con recipient picker: who the carrier profile knows,
 * who is ticked by default, and how the free-text CC box is split.
 */
import { dedupeEmails, emailKey, isEmailAddress } from '@/lib/emailAddress'
import type { CarrierContactRecord, CarrierRecord, LoadCarrierRecord } from '@/types/tms'

export interface RecipientOption {
  email: string
  label: string
}

/** `AFTER_HOURS` → `After hours`. */
function typeLabel(type: string): string {
  const text = type.replace(/_/g, ' ').toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function contactLabel(c: CarrierContactRecord): string {
  const role = c.rateConRecipient ? 'Rate con' : c.types?.[0] ? typeLabel(c.types[0]) : ''
  return role ? `${c.name} · ${role}` : c.name
}

/**
 * Every address the profile knows for this booking: active contacts, then the dispatcher
 * on this booking, the carrier's dispatcher and its main e-mail. Malformed stored
 * addresses are not offered; duplicates (any case) keep their first label.
 */
export function knownRecipientOptions(args: {
  carrier: CarrierRecord | null
  contacts: CarrierContactRecord[]
  loadCarrier: LoadCarrierRecord | null
}): RecipientOption[] {
  const { carrier, contacts, loadCarrier } = args
  const raw: RecipientOption[] = [
    ...contacts
      .filter((c) => c.active !== false && c.email)
      .map((c) => ({ email: (c.email as string).trim(), label: contactLabel(c) })),
    { email: (loadCarrier?.dispatcherEmail ?? '').trim(), label: 'Dispatcher on this booking' },
    { email: (carrier?.dispatcherEmail ?? '').trim(), label: 'Carrier dispatcher' },
    { email: (carrier?.email ?? '').trim(), label: 'Carrier e-mail' },
  ]
  const seen = new Set<string>()
  const out: RecipientOption[] = []
  for (const o of raw) {
    if (!isEmailAddress(o.email)) continue
    const key = emailKey(o.email)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(o)
  }
  return out
}

/**
 * Who is ticked before anyone touches the picker — contacts flagged as rate-con
 * recipients or typed DISPATCH; the carrier's own dispatcher/main e-mail when the profile
 * has none.
 */
export function defaultSelection(args: {
  carrier: CarrierRecord | null
  contacts: CarrierContactRecord[]
}): string[] {
  const { carrier, contacts } = args
  const picked = contacts
    .filter((c) => c.active !== false && c.email)
    .filter((c) => c.rateConRecipient || c.types?.includes('DISPATCH'))
    .map((c) => c.email as string)
  const fallback = [carrier?.dispatcherEmail, carrier?.email].filter((e): e is string => !!e)
  return dedupeEmails(picked.length > 0 ? picked : fallback).filter(isEmailAddress)
}

/** Splits the CC box on commas, semicolons and whitespace; tokens failing the shared rule are reported. */
export function parseCcList(text: string): { emails: string[]; invalid: string[] } {
  const tokens = text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
  const emails: string[] = []
  const invalid: string[] = []
  for (const t of tokens) (isEmailAddress(t) ? emails : invalid).push(t)
  return { emails: dedupeEmails(emails), invalid }
}

export type CommitAddressResult =
  | { ok: true; selected: string[]; extras: string[] }
  | { ok: false; error: string }

/**
 * Adds one typed address to the picker state. An address equal (any case) to a known
 * option just ticks that option; one already added is ignored; anything failing the
 * shared rule is refused with a message and nothing changes.
 */
export function commitAddress(args: {
  text: string
  options: RecipientOption[]
  selected: string[]
  extras: string[]
}): CommitAddressResult {
  const { options, selected, extras } = args
  const text = args.text.trim()
  if (!isEmailAddress(text)) return { ok: false, error: `"${text}" is not a valid email address.` }
  const key = emailKey(text)
  const option = options.find((o) => emailKey(o.email) === key)
  if (option) {
    const ticked = selected.some((s) => emailKey(s) === key)
    return { ok: true, selected: ticked ? selected : [...selected, option.email], extras }
  }
  if (extras.some((x) => emailKey(x) === key)) return { ok: true, selected, extras }
  return { ok: true, selected, extras: [...extras, text] }
}
