/**
 * What a person actually wrote in an e-mail, for a conversation view that reads like text messages: the quoted earlier messages,
 * the reply header ("On Tue, Nov 10 ... wrote:"), the signature block, mobile footers and legal disclaimers are dropped.
 * Pure and conservative: it only cuts at lines that are unmistakably one of those, and falls back to the original text when
 * cutting would leave nothing. The full text is always one click away in the UI.
 */

export interface CleanedEmail {
  /** The message as a person would say it. */
  text: string
  /** True when something was cut (the UI offers "Show full e-mail"). */
  trimmed: boolean
}

/** A line that starts the quoted earlier message or a forwarded block: everything from here on is somebody else's text. */
const QUOTE_START = [
  /^on .{6,}wrote:?\s*$/i,
  /^on .{6,},?\s*$/i, // "On Tue, Nov 10, 2026 at 11:25 AM Name <a@b.com>" with "wrote:" on the next line (checked below)
  /^-{2,}\s*original message\s*-{2,}\s*$/i,
  /^-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^begin forwarded message:?\s*$/i,
  /^_{5,}\s*$/,
  /^from:\s.+$/i, // an Outlook header block: only counts when a Sent:/Date: line follows within a few lines (checked below)
]

/** A signature closer: kept as the end of the message when short text precedes it, with the lines after it cut. */
const CLOSER = /^(best regards|best|regards|kind regards|warm regards|sincerely|thanks|thank you|thanks again|many thanks|cheers|respectfully)[,!.\s]*$/i

/** Footers that are never the person's words. */
const FOOTER = [
  /^sent from my (iphone|ipad|android|galaxy|mobile|samsung|phone).*$/i,
  /^get outlook for .*$/i,
  /^sent from (mail|outlook|yahoo mail|gmail).*$/i,
  /^this (e-?mail|message) .*(confidential|intended (solely )?for|privileged).*$/i,
  /^confidentiality notice.*$/i,
  /^to unsubscribe from this group.*$/i,
  /^[—–-]+\s*[A-Z][\w.' -]+,?\s+BCAT Tracking\s*$/, // our own sign-off on tracking e-mails
]

const isBlank = (l: string): boolean => l.trim() === ''

function quoteStartIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (/^>+/.test(line)) return i
    if (/^--\s*$/.test(lines[i]) || /^-{2}\s*$/.test(line)) return i // the conventional signature delimiter
    for (const re of QUOTE_START) {
      if (!re.test(line)) continue
      if (re === QUOTE_START[1]) {
        // "On ... <addr>" then "wrote:" on the next non-empty line.
        const next = lines.slice(i + 1, i + 3).find((l) => !isBlank(l))
        if (next && /^wrote:?\s*$/i.test(next.trim())) return i
        continue
      }
      if (re === QUOTE_START[6]) {
        const ahead = lines.slice(i + 1, i + 6).join('\n')
        if (/^(sent|date):\s/im.test(ahead)) return i
        continue
      }
      return i
    }
  }
  return -1
}

export function cleanEmailBody(raw: string | null | undefined): CleanedEmail {
  const original = String(raw ?? '').replace(/\r\n?/g, '\n')
  if (!original.trim()) return { text: '', trimmed: false }
  let lines = original.split('\n')

  const cut = quoteStartIndex(lines)
  if (cut >= 0) lines = lines.slice(0, cut)

  // Footers anywhere in what is left (a mobile tag sits right under the text).
  lines = lines.filter((l) => !FOOTER.some((re) => re.test(l.trim())))

  // Signature: after a closer ("Best Regards,") keep the closer, drop what follows (name, title, address, phones).
  const closer = lines.findIndex((l) => CLOSER.test(l.trim()))
  if (closer > 0) {
    const before = lines.slice(0, closer).filter((l) => !isBlank(l))
    if (before.length > 0) lines = lines.slice(0, closer)
  }

  // Tidy: trailing/leading blanks, runs of blank lines, rules of dashes or underscores.
  const tidy: string[] = []
  for (const line of lines) {
    if (/^[\s_=-]{4,}$/.test(line)) continue
    if (isBlank(line) && (tidy.length === 0 || isBlank(tidy[tidy.length - 1]))) continue
    tidy.push(line.replace(/\s+$/, ''))
  }
  while (tidy.length > 0 && isBlank(tidy[tidy.length - 1])) tidy.pop()
  const text = tidy.join('\n').trim()

  // Cutting must never leave nothing: a message that is only a quote or only a signature shows as it came.
  if (!text) return { text: original.trim(), trimmed: false }
  return { text, trimmed: text !== original.trim() }
}
