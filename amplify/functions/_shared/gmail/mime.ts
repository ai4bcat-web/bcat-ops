/**
 * RFC 5322 plain-text message builder for Gmail drafts / sends. Any CR or LF in a
 * header value is refused (header injection); the body is UTF-8, quoted-printable.
 */
import type { OutgoingReply } from '../../../../src/lib/spot/port'

export function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Refusing a ${name} header containing a line break.`)
  return value
}

/** RFC 2047 encoded-word for non-ASCII header text. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export function quotedPrintable(text: string): string {
  const bytes = Buffer.from(text.replace(/\r\n|\r|\n/g, '\n'), 'utf8')
  let line = ''
  const out: string[] = []
  const push = (chunk: string) => {
    if (line.length + chunk.length > 75) {
      out.push(`${line}=`)
      line = ''
    }
    line += chunk
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x0a) {
      // A trailing space or tab before a line break must be encoded.
      if (line.endsWith(' ') || line.endsWith('\t')) {
        const last = line.charCodeAt(line.length - 1)
        line = `${line.slice(0, -1)}=${last.toString(16).toUpperCase().padStart(2, '0')}`
      }
      out.push(line)
      line = ''
    } else if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) {
      push(String.fromCharCode(b))
    } else {
      push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`)
    }
  }
  out.push(line)
  return out.join('\r\n')
}

export function buildMime(d: OutgoingReply, from?: string): string {
  const headers: string[] = []
  if (from) headers.push(`From: ${assertHeaderSafe('From', from)}`)
  headers.push(`To: ${assertHeaderSafe('To', d.to)}`)
  headers.push(`Subject: ${encodeHeader(assertHeaderSafe('Subject', d.subject))}`)
  if (d.inReplyTo) headers.push(`In-Reply-To: ${assertHeaderSafe('In-Reply-To', d.inReplyTo)}`)
  if (d.references) headers.push(`References: ${assertHeaderSafe('References', d.references)}`)
  headers.push('MIME-Version: 1.0')
  headers.push('Content-Type: text/plain; charset=UTF-8')
  headers.push('Content-Transfer-Encoding: quoted-printable')
  return `${headers.join('\r\n')}\r\n\r\n${quotedPrintable(d.text)}`
}

export function base64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}
