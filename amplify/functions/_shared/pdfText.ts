/**
 * Best-effort text out of a PDF, with no PDF library: inflate every content stream (Flate, or
 * as-is when uncompressed) and pull the strings out of the text-showing operators — `(…) Tj`,
 * `[(…) …] TJ` and `<hex>` strings — plus any literal strings in the raw bytes. Good enough to
 * find "$1,470.00" in a PDF a program wrote (our rate con, a broker's rate con, a load summary).
 * A scanned image has no text and returns little or nothing: that is a known limit, not a pass.
 */
import { inflateSync } from 'node:zlib'

const MAX_STREAMS = 400

function unescapePdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? c)
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

function stringsIn(content: string): string[] {
  const out: string[] = []
  // Literal strings, allowing one level of escaped parentheses.
  for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) out.push(unescapePdfString(m[1]))
  // Hex strings used as text: <004100420043> or <414243>.
  for (const m of content.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) {
    const hex = m[1].replace(/\s+/g, '')
    if (hex.length % 2) continue
    let s = ''
    const twoByte = hex.length % 4 === 0 && /^(00[0-9A-Fa-f]{2})+$/.test(hex)
    const step = twoByte ? 4 : 2
    for (let i = 0; i < hex.length; i += step) s += String.fromCharCode(parseInt(hex.slice(i, i + step), 16))
    if (/[ -~]/.test(s)) out.push(s)
  }
  return out
}

export function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes)
  const latin = buf.toString('latin1')
  if (!latin.startsWith('%PDF')) return ''
  const parts: string[] = []
  let count = 0
  const re = /stream\r?\n/g
  for (let m = re.exec(latin); m && count < MAX_STREAMS; m = re.exec(latin)) {
    const start = m.index + m[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) break
    const body = buf.subarray(start, end)
    let decoded: string
    try {
      decoded = inflateSync(body).toString('latin1')
    } catch {
      decoded = body.toString('latin1')
    }
    if (/T[Jj]|Tf/.test(decoded)) parts.push(stringsIn(decoded).join(' '))
    count += 1
    re.lastIndex = end
  }
  return parts.join('\n')
}
