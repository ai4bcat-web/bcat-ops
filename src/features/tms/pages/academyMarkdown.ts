/**
 * The Academy's markdown renderer: `Docs/academy/*.md` in, blocks the page can render out.
 *
 * Dependency-free on purpose — the knowledge base is our own text, not user input, and a
 * markdown library is a lot of bytes for headings, lists, code and a few tables. It
 * handles the subset the articles actually use: ATX headings, paragraphs, bullet and
 * numbered lists, fenced code, pipe tables, and inline bold / italic / code / links.
 * Inline marks inside a link label are not re-parsed; nothing in the articles needs it.
 */

export interface MdSpan {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  /** Set on a link span; the text is the label. */
  href?: string
}

export type MdBlock =
  | { kind: 'heading'; level: number; spans: MdSpan[] }
  | { kind: 'paragraph'; spans: MdSpan[] }
  | { kind: 'list'; ordered: boolean; items: MdSpan[][] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'table'; header: MdSpan[][]; rows: MdSpan[][][] }

export interface FrontMatter {
  /** The `key: value` pairs of the leading `---` block; list values stay raw text. */
  data: Record<string, string>
  body: string
}

/**
 * Splits the leading `---` front-matter block (see `Docs/academy/README.md`) off an
 * article. A file without one is all body.
 */
export function parseFrontMatter(src: string): FrontMatter {
  const text = src.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const head = text.slice(text.indexOf('\n') + 1, end)
  const bodyAt = text.indexOf('\n', end + 1)
  const body = bodyAt === -1 ? '' : text.slice(bodyAt + 1)
  const data: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    data[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { data, body }
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g

/** Bold / italic / inline code / links, in source order, with the plain text between. */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = []
  let at = 0
  INLINE.lastIndex = 0
  let match = INLINE.exec(text)
  while (match) {
    if (match.index > at) spans.push({ text: text.slice(at, match.index) })
    const token = match[0]
    if (token.startsWith('`')) {
      spans.push({ text: token.slice(1, -1), code: true })
    } else if (token.startsWith('**')) {
      spans.push({ text: token.slice(2, -2), bold: true })
    } else if (token.startsWith('*') || token.startsWith('_')) {
      spans.push({ text: token.slice(1, -1), italic: true })
    } else {
      const split = token.indexOf('](')
      spans.push({ text: token.slice(1, split), href: token.slice(split + 2, -1) })
    }
    at = match.index + token.length
    match = INLINE.exec(text)
  }
  if (at < text.length) spans.push({ text: text.slice(at) })
  return spans
}

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^[-*]\s+(.*)$/
const NUMBERED = /^\d+[.)]\s+(.*)$/
const FENCE = /^```\s*(\S*)\s*$/
/** A `| --- | :--: |` row: the alignment line under a table header, never content. */
const TABLE_RULE = /^\|?[\s:|-]+\|[\s:|-]*$/

function tableCells(line: string): MdSpan[][] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => parseInline(cell.trim()))
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let paragraph: string[] = []

  const flush = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i++ }
      blocks.push({ kind: 'code', lang: fence[1] || null, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') { flush(); continue }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseInline(heading[2].trim()) })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      flush()
      const ordered = numbered !== null
      const items: MdSpan[][] = []
      while (i < lines.length) {
        const row = ordered ? NUMBERED.exec(lines[i]) : BULLET.exec(lines[i])
        if (!row) break
        items.push(parseInline(row[1].trim()))
        i++
      }
      i--
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    if (line.trim().startsWith('|')) {
      flush()
      const rows: MdSpan[][][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!TABLE_RULE.test(lines[i].trim())) rows.push(tableCells(lines[i]))
        i++
      }
      i--
      const header = rows.shift() ?? []
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

/** The article's own title: front-matter first, then its first heading, then the slug. */
export function articleTitle(src: string, fallback: string): string {
  const { data, body } = parseFrontMatter(src)
  if (data.title) return data.title
  const heading = HEADING.exec(body.split('\n').find((l) => HEADING.test(l)) ?? '')
  return heading ? heading[2].trim() : fallback
}
