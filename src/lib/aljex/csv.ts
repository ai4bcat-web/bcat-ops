/**
 * Streaming, chunk-safe CSV for the Aljex export: quoted fields, `""` escapes, embedded
 * newlines, CRLF/LF/CR row ends, leading BOM, comma/tab/pipe delimiter. Push text chunks,
 * receive rows; a chunk boundary may fall anywhere (inside a quoted field, between CR and LF,
 * between a closing quote and the next char). Rows are NOT padded here: the export is
 * right-truncated and `mapAljexRow` treats missing trailing cells as blank.
 */

export type CsvDelimiter = ',' | '\t' | '|'

export interface CsvParser {
  write(chunk: string): void
  /** Flush a final row that has no terminating newline. */
  end(): void
}

export function createCsvParser(onRow: (row: string[]) => void, opts: { delimiter?: CsvDelimiter } = {}): CsvParser {
  const delimiter = opts.delimiter ?? ','
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let pendingQuote = false // saw a quote while inQuotes; the next char decides escape vs close
  let skipLf = false // previous char was CR
  let atStart = true
  let fieldStarted = false

  const endField = () => {
    row.push(field)
    field = ''
    fieldStarted = false
  }
  const endRow = () => {
    endField()
    const r = row
    row = []
    onRow(r)
  }

  function write(chunk: string): void {
    let i = 0
    if (atStart && chunk.length) {
      if (chunk.charCodeAt(0) === 0xfeff) i = 1
      atStart = false
    }
    for (; i < chunk.length; i++) {
      const c = chunk[i]
      if (skipLf) {
        skipLf = false
        if (c === '\n') continue
      }
      if (pendingQuote) {
        pendingQuote = false
        if (c === '"') {
          field += '"'
          continue
        }
        inQuotes = false // closing quote; handle c unquoted
      }
      if (inQuotes) {
        if (c === '"') pendingQuote = true
        else field += c
        continue
      }
      if (c === '"' && !fieldStarted) {
        inQuotes = true
        fieldStarted = true
      } else if (c === delimiter) {
        endField()
      } else if (c === '\n') {
        endRow()
      } else if (c === '\r') {
        endRow()
        skipLf = true
      } else {
        field += c
        fieldStarted = true
      }
    }
  }

  function end(): void {
    if (pendingQuote) {
      pendingQuote = false
      inQuotes = false
    }
    if (fieldStarted || field !== '' || row.length) endRow()
  }

  return { write, end }
}

/** Convenience for small inputs and tests: parse a whole string. */
export function parseCsvText(text: string, delimiter: CsvDelimiter = ','): string[][] {
  const rows: string[][] = []
  const p = createCsvParser((r) => rows.push(r), { delimiter })
  p.write(text)
  p.end()
  return rows
}

/** Delimiter of a header line: the one of `, \t |` that occurs most outside quotes (comma on a tie/none). */
export function sniffDelimiter(headerLine: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, '\t': 0, '|': 0 }
  let inQuotes = false
  for (const c of headerLine) {
    if (c === '"') inQuotes = !inQuotes
    else if (!inQuotes && (c === ',' || c === '\t' || c === '|')) counts[c]++
  }
  let best: CsvDelimiter = ','
  for (const d of ['\t', '|'] as const) if (counts[d] > counts[best]) best = d
  return best
}

export class EncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncodingError'
  }
}

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'

export interface ByteDecoder {
  /** Decoded text available so far ('' while the encoding is still being decided). */
  write(chunk: Uint8Array): string
  end(): string
  readonly encoding: CsvEncoding | null
}

const SNIFF_BYTES = 64 * 1024

/**
 * Bytes -> text, chunk-safe. A BOM picks UTF-8/UTF-16; otherwise the first 64 KB are tried as
 * strict UTF-8 and, if they are not valid, the whole stream is read as Windows-1252. A UTF-8 file
 * that turns invalid only after the sniff window throws `EncodingError` (never silently mangles).
 */
export function createByteDecoder(): ByteDecoder {
  let decoder: TextDecoder | null = null
  let encoding: CsvEncoding | null = null
  let head: Uint8Array[] = []
  let headLen = 0

  const choose = (): string => {
    const buf = new Uint8Array(headLen)
    let o = 0
    for (const h of head) {
      buf.set(h, o)
      o += h.length
    }
    head = []
    if (buf[0] === 0xff && buf[1] === 0xfe) encoding = 'utf-16le'
    else if (buf[0] === 0xfe && buf[1] === 0xff) encoding = 'utf-16be'
    else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) encoding = 'utf-8'
    else {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true })
        encoding = 'utf-8'
      } catch {
        encoding = 'windows-1252'
      }
    }
    decoder = new TextDecoder(encoding, { fatal: encoding === 'utf-8' })
    return decode(buf, true)
  }
  const decode = (buf: Uint8Array, stream: boolean): string => {
    try {
      return (decoder as TextDecoder).decode(buf, { stream })
    } catch {
      throw new EncodingError('File is not valid UTF-8 (and was not detected as another encoding)')
    }
  }

  return {
    get encoding() {
      return encoding
    },
    write(chunk) {
      if (!decoder) {
        head.push(chunk)
        headLen += chunk.length
        return headLen >= SNIFF_BYTES ? choose() : ''
      }
      return decode(chunk, true)
    },
    end() {
      if (!decoder) return headLen ? choose() + decode(new Uint8Array(0), false) : ''
      return decode(new Uint8Array(0), false)
    },
  }
}
