/**
 * The Academy: `Docs/academy/*.md` rendered in the app.
 *
 * The articles are bundled at build time (`import.meta.glob`), so the knowledge base ships
 * with the code it documents and cannot drift behind a deploy. The Ask assistant that
 * answers questions over these articles is Step M; this is the reading room.
 */
import { Fragment } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TmsBadge, TmsCard, TmsEmptyState, TmsPage } from '@/features/tms/kit'
import { articleTitle, parseFrontMatter, parseMarkdown, type MdBlock, type MdSpan } from './academyMarkdown'

const FILES = import.meta.glob('../../../../Docs/academy/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export interface AcademyArticle {
  slug: string
  title: string
  category: string | null
  /** The first paragraph, for the index list. */
  summary: string
  blocks: MdBlock[]
}

function buildArticles(): AcademyArticle[] {
  const articles: AcademyArticle[] = []
  for (const [path, source] of Object.entries(FILES)) {
    const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
    // README.md is the index of the folder, not an article.
    if (file.toLowerCase() === 'readme') continue
    const { data, body } = parseFrontMatter(source)
    const blocks = parseMarkdown(body)
    // The title row already shows the article's name; a leading `# Title` repeats it.
    if (blocks[0]?.kind === 'heading' && blocks[0].level === 1) blocks.shift()
    const firstParagraph = blocks.find((b) => b.kind === 'paragraph')
    const lead = firstParagraph ? firstParagraph.spans.map((s) => s.text).join('') : ''
    articles.push({
      slug: data.slug || file,
      title: articleTitle(source, file),
      category: data.category || null,
      summary: lead.length > 180 ? `${lead.slice(0, 180).trimEnd()}…` : lead,
      blocks,
    })
  }
  return articles.sort((a, b) => a.title.localeCompare(b.title))
}

const ARTICLES = buildArticles()

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.href !== undefined) {
          // Articles link each other by file name; those become Academy routes.
          const internal = span.href.endsWith('.md')
          return internal
            ? <Link key={i} to={`/tms/academy/${span.href.replace(/\.md$/, '')}`}>{span.text}</Link>
            : <a key={i} href={span.href} target="_blank" rel="noreferrer">{span.text}</a>
        }
        if (span.code) return <code key={i} className="tms-academy-code">{span.text}</code>
        if (span.bold) return <strong key={i}>{span.text}</strong>
        if (span.italic) return <em key={i}>{span.text}</em>
        return <Fragment key={i}>{span.text}</Fragment>
      })}
    </>
  )
}

function Blocks({ blocks }: { blocks: MdBlock[] }) {
  return (
    <div className="tms-academy-body">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          const Tag = (block.level <= 2 ? 'h2' : block.level === 3 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4'
          return <Tag key={i} style={{ marginTop: 20, marginBottom: 8 }}><Spans spans={block.spans} /></Tag>
        }
        if (block.kind === 'paragraph') {
          return <p key={i} style={{ marginBottom: 10, lineHeight: 1.6 }}><Spans spans={block.spans} /></p>
        }
        if (block.kind === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul'
          return (
            <Tag key={i} style={{ margin: '0 0 12px 20px', lineHeight: 1.6 }}>
              {block.items.map((item, j) => <li key={j}><Spans spans={item} /></li>)}
            </Tag>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre key={i} style={{
              background: 'var(--tms-card)', border: '1px solid var(--tms-border)',
              borderRadius: 'var(--tms-radius)', padding: 12, overflowX: 'auto', marginBottom: 12,
            }}><code>{block.text}</code></pre>
          )
        }
        return (
          <table key={i} className="tms-table" style={{ marginBottom: 12 }}>
            <thead>
              <tr>{block.header.map((cell, j) => <th key={j}><Spans spans={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j}>{row.map((cell, k) => <td key={k}><Spans spans={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        )
      })}
    </div>
  )
}

export function AcademyPage() {
  const { slug } = useParams<{ slug: string }>()

  if (slug) {
    const article = ARTICLES.find((a) => a.slug === slug)
    if (!article) {
      return (
        <TmsPage title="Academy">
          <TmsEmptyState
            title="That article is not in the Academy."
            message="It may have been renamed. The index lists everything that ships with this build."
          />
          <p style={{ marginTop: 12 }}><Link to="/tms/academy">Back to the Academy</Link></p>
        </TmsPage>
      )
    }
    return (
      <TmsPage
        title={<>{article.title} <TmsBadge tone="purple">BETA</TmsBadge></>}
        actions={<Link to="/tms/academy">All articles</Link>}
      >
        <TmsCard>
          <Blocks blocks={article.blocks} />
        </TmsCard>
      </TmsPage>
    )
  }

  return (
    <TmsPage title={<>Academy <TmsBadge tone="purple">BETA</TmsBadge></>}>
      <TmsCard title={`${ARTICLES.length} articles`}>
        <p style={{ color: 'var(--tms-muted)', marginBottom: 14 }}>
          How this TMS works, written against the build you are running. Ask — the assistant
          that answers questions out of these articles — arrives in Step M; until then this
          is the reading room.
        </p>
        <ul style={{ listStyle: 'none', display: 'grid', gap: 10 }}>
          {ARTICLES.map((article) => (
            <li key={article.slug}>
              <Link to={`/tms/academy/${article.slug}`} style={{ fontWeight: 600 }}>{article.title}</Link>
              {article.category ? <span style={{ color: 'var(--tms-muted)', marginLeft: 8, fontSize: 12 }}>{article.category}</span> : null}
              {article.summary ? (
                <div style={{ color: 'var(--tms-muted)', marginTop: 2, lineHeight: 1.5 }}>{article.summary}</div>
              ) : null}
            </li>
          ))}
        </ul>
      </TmsCard>
    </TmsPage>
  )
}

export default AcademyPage
