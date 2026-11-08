/**
 * Control-character handling shared by the spot libs (no control-character regexes, which the
 * lint rule rightly distrusts). Pure; relative imports only.
 */

/**
 * Replaces ASCII control characters (and DEL) with `replacement`. With `keepNewline`, `\n` and
 * `\t` survive and a bare `\r` is dropped (so CRLF becomes LF).
 */
export function stripControl(value: string, replacement = ' ', keepNewline = false): string {
  let out = ''
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (keepNewline && (ch === '\n' || ch === '\t')) out += ch
    else if (keepNewline && ch === '\r') continue
    else out += code < 32 || code === 127 ? replacement : ch
  }
  return out
}
