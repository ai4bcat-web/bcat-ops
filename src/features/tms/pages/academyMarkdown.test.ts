/**
 * The Academy renders our own knowledge base, so the parser has to be right about the
 * shapes those articles actually use. What breaks silently: a fenced code block eaten as
 * paragraphs, a table's alignment row rendered as content, and inline marks swallowing
 * the text between them.
 */
import { describe, it, expect } from 'vitest'
import { parseFrontMatter, parseInline, parseMarkdown, articleTitle } from './academyMarkdown'

describe('parseFrontMatter', () => {
  it('reads the block and hands back the body without it', () => {
    const { data, body } = parseFrontMatter('---\ntitle: Quotes and Lane Rates\nslug: quotes-and-lane-rates\n---\n# Quotes\n\nBody.\n')
    expect(data.title).toBe('Quotes and Lane Rates')
    expect(data.slug).toBe('quotes-and-lane-rates')
    expect(body.startsWith('# Quotes')).toBe(true)
  })

  it('leaves a file without front matter alone', () => {
    const { data, body } = parseFrontMatter('# Plain\n\nText.')
    expect(data).toEqual({})
    expect(body).toBe('# Plain\n\nText.')
  })
})

describe('parseInline', () => {
  it('keeps the plain text between marks', () => {
    expect(parseInline('Set **AR status** to `UNBILLED` on the *shipment*')).toEqual([
      { text: 'Set ' },
      { text: 'AR status', bold: true },
      { text: ' to ' },
      { text: 'UNBILLED', code: true },
      { text: ' on the ' },
      { text: 'shipment', italic: true },
    ])
  })

  it('reads a link as a label and a href', () => {
    expect(parseInline('see [the AR article](ar-invoicing-and-payments.md) first')).toEqual([
      { text: 'see ' },
      { text: 'the AR article', href: 'ar-invoicing-and-payments.md' },
      { text: ' first' },
    ])
  })
})

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and both kinds of list', () => {
    const blocks = parseMarkdown('# Title\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n')
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, spans: [{ text: 'Title' }] })
    expect(blocks[1]).toEqual({ kind: 'paragraph', spans: [{ text: 'First line second line' }] })
    expect(blocks[2]).toEqual({ kind: 'list', ordered: false, items: [[{ text: 'one' }], [{ text: 'two' }]] })
    expect(blocks[3]).toEqual({ kind: 'list', ordered: true, items: [[{ text: 'first' }], [{ text: 'second' }]] })
  })

  it('keeps fenced code verbatim, marks included', () => {
    const blocks = parseMarkdown('Before\n\n```ts\nconst a = `x` // **not bold**\n  indented\n```\n\nAfter\n')
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = `x` // **not bold**\n  indented' })
    expect(blocks[2]).toEqual({ kind: 'paragraph', spans: [{ text: 'After' }] })
  })

  it('splits a table into a header and rows, dropping the alignment line', () => {
    const blocks = parseMarkdown('| Rung | Who |\n| --- | :--: |\n| UNBILLED | AR |\n| PAID | AR |\n')
    expect(blocks).toEqual([{
      kind: 'table',
      header: [[{ text: 'Rung' }], [{ text: 'Who' }]],
      rows: [
        [[{ text: 'UNBILLED' }], [{ text: 'AR' }]],
        [[{ text: 'PAID' }], [{ text: 'AR' }]],
      ],
    }])
  })

  it('does not run a heading into the paragraph above it', () => {
    const blocks = parseMarkdown('Lead in\n## Second\nAfter\n')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'heading', 'paragraph'])
  })
})

describe('articleTitle', () => {
  it('prefers the front-matter title', () => {
    expect(articleTitle('---\ntitle: Commissions\n---\n# Something else\n', 'fallback')).toBe('Commissions')
  })

  it('falls back to the first heading, then to the slug', () => {
    expect(articleTitle('# Reports\n\nText', 'reports')).toBe('Reports')
    expect(articleTitle('Just text', 'reports')).toBe('reports')
  })
})
