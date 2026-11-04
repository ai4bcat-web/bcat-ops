import { describe, expect, it } from 'vitest'
import { createByteDecoder, createCsvParser, EncodingError, parseCsvText, sniffDelimiter } from './csv'

const text = '\ufeff"a","b ""q""","c\nd"\r\n"1","","3"\r\n"x"'

function parseChunks(chunks: string[], delimiter?: ',' | '\t' | '|'): string[][] {
  const rows: string[][] = []
  const p = createCsvParser((r) => rows.push(r), { delimiter })
  for (const c of chunks) p.write(c)
  p.end()
  return rows
}

describe('csv parser', () => {
  const expected = [
    ['a', 'b "q"', 'c\nd'],
    ['1', '', '3'],
    ['x'],
  ]

  it('parses quotes, escaped quotes, embedded newlines, CRLF, BOM and a final row without newline', () => {
    expect(parseCsvText(text)).toEqual(expected)
  })

  it('gives the same rows wherever the chunk boundary falls (inside a quoted field, between CR and LF, after a closing quote)', () => {
    for (let cut = 1; cut < text.length; cut++) {
      expect(parseChunks([text.slice(0, cut), text.slice(cut)])).toEqual(expected)
    }
    expect(parseChunks([...text])).toEqual(expected)
  })

  it('keeps ragged rows ragged (the export is right-truncated; padding is the mapper’s job)', () => {
    expect(parseCsvText('"a","b","c"\n"1"\n"1","2"\n')).toEqual([['a', 'b', 'c'], ['1'], ['1', '2']])
  })

  it('honours tab and pipe delimiters and sniffs them from a header outside quotes', () => {
    expect(parseCsvText('a\tb,c\n1\t2\n', '\t')).toEqual([['a', 'b,c'], ['1', '2']])
    expect(sniffDelimiter('"a|b"\t"c"\t"d"')).toBe('\t')
    expect(sniffDelimiter('a|b|c,d')).toBe('|')
    expect(sniffDelimiter('"a","b"')).toBe(',')
    expect(sniffDelimiter('abc')).toBe(',')
  })
})

describe('byte decoder', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const decodeAll = (chunks: Uint8Array[]) => {
    const d = createByteDecoder()
    let out = ''
    for (const c of chunks) out += d.write(c)
    return { out: out + d.end(), encoding: d.encoding }
  }

  it('decodes UTF-8 with a BOM and a multi-byte character split across chunks', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('caf\u00e9 \u5317')])
    const { out, encoding } = decodeAll([...bytes].map((b) => new Uint8Array([b])))
    expect(out).toBe('caf\u00e9 \u5317')
    expect(encoding).toBe('utf-8')
  })

  it('decodes UTF-16LE with a BOM', () => {
    const body = 'ab,\u00e9\n'
    const bytes = new Uint8Array(2 + body.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < body.length; i++) {
      bytes[2 + i * 2] = body.charCodeAt(i) & 0xff
      bytes[3 + i * 2] = body.charCodeAt(i) >> 8
    }
    expect(decodeAll([bytes])).toEqual({ out: body, encoding: 'utf-16le' })
  })

  it('falls back to Windows-1252 when the file is not valid UTF-8', () => {
    const bytes = new Uint8Array([...enc('na'), 0xef, ...enc('ve,caf'), 0xe9])
    expect(decodeAll([bytes])).toEqual({ out: 'na\u00efve,caf\u00e9', encoding: 'windows-1252' })
  })

  it('refuses (never mangles) a file that turns out invalid UTF-8 only after the sniff window', () => {
    const good = enc('a'.repeat(70 * 1024))
    const d = createByteDecoder()
    d.write(good)
    expect(() => d.write(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(EncodingError)
  })
})
