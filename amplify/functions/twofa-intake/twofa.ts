/**
 * Pure helpers for the 2FA relay: pull the sender and text out of a Google Voice
 * "new text message" email, and the one-time code out of the text.
 */

export interface GoogleVoiceText {
  /** The number that sent the text, as Google Voice prints it, e.g. "(989) 601-2969" or a short code. */
  from: string | null
  /** The text itself, without Google Voice's footer. */
  text: string
}

/** Google Voice subjects read "New text message from (989) 601-2969" (or "from 262966"). */
export function parseGoogleVoiceEmail(subject: string, body: string): GoogleVoiceText | null {
  const m = /new text message from\s+(.+?)\s*$/i.exec((subject ?? '').trim())
  if (!m) return null
  // The forward's body is the message, then a footer that starts with "YOUR ACCOUNT" or
  // "To respond to this text message…". Keep what comes before either.
  const raw = (body ?? '').replace(/\r/g, '')
  const cut = raw.search(/\n\s*(YOUR ACCOUNT|To respond to this text message|Google Voice|https?:\/\/voice\.google\.com)/i)
  const text = (cut >= 0 ? raw.slice(0, cut) : raw).trim()
  return { from: m[1].trim() || null, text }
}

/**
 * The code in a verification text: 4–8 digits, preferring one that sits next to a word
 * like "code", "verification", "passcode", "OTP" or "PIN". Letters-and-digits codes
 * (e.g. "G-482913", "AB12CD") are accepted when the text says they are a code.
 */
export function extractVerificationCode(text: string): string | null {
  const t = text ?? ''
  const near = /(?:code|passcode|password|pin|otp|one[- ]time|verification|verify|security|token)[^0-9A-Za-z]{0,40}?([A-Z]?-?\d{4,8}|\d{3}[- ]\d{3})/i.exec(t)
  if (near) return near[1].replace(/\s/g, '')
  const before = /\b([A-Z]-\d{4,8}|\d{3}[- ]\d{3}|\d{4,8})[^0-9A-Za-z]{0,40}?(?:is your|verification|code|passcode|otp|pin)/i.exec(t)
  if (before) return before[1].replace(/\s/g, '')
  const lone = /\b(\d{6})\b/.exec(t) ?? /\b(\d{4,8})\b/.exec(t)
  return lone ? lone[1] : null
}

/** True when the text reads like a one-time code, so other Google Voice texts stay out of the channel. */
export function looksLikeVerification(text: string): boolean {
  return /(code|passcode|verification|verify|otp|one[- ]time|pin|security|sign[- ]in|login|log in|authenticat)/i.test(text ?? '') && /\d{4,8}|\d{3}[- ]\d{3}/.test(text ?? '')
}

/** The Slack line: the code first and big, then who it came from, then the full text as a quote. */
export function slackMessage(input: { code: string | null; from: string | null; text: string; receivedAt?: string | null }): string {
  const when = input.receivedAt && !Number.isNaN(Date.parse(input.receivedAt))
    ? new Date(input.receivedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
    : null
  const head = input.code ? `:closed_lock_with_key: *Code ${input.code}*` : ':closed_lock_with_key: *Verification text*'
  const meta = [input.from ? `from ${input.from}` : null, when].filter(Boolean).join(' · ')
  const quote = input.text.split('\n').map((l) => `> ${l}`).join('\n')
  return `${head}${meta ? `  ${meta}` : ''}\n${quote}`
}
