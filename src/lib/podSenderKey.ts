/**
 * Stable backend key for a sender. Phone-first (last 10 digits); otherwise a
 * normalized name key so email-only senders can also be mapped.
 * Returns null when neither a phone nor a usable name is present.
 */
export function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '').slice(-10)
}

export function nameKey(s: string | null | undefined): string {
  return ((s ?? '').toLowerCase().match(/[a-z]+/g) ?? []).join('')
}

export function senderKey(doc: { senderName: string; senderContact: string }): string | null {
  const phone = digits(doc.senderContact)
  if (phone.length === 10) return `phone:${phone}`
  const name = nameKey(doc.senderName)
  if (name.length >= 2) return `name:${name}`
  return null
}
