/**
 * The Academy: `Docs/academy/*.md` rendered in the app, plus the Ask assistant.
 *
 * The articles are bundled at build time (`import.meta.glob`), so the knowledge base ships
 * with the code it documents and cannot drift behind a deploy. Ask sends the bundled
 * articles to the `ASK_ACADEMY` Lambda action and returns a cited answer grounded in them.
 */
import { Fragment, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsField, TmsPage, TmsTextarea } from '@/features/tms/kit'
import { askAcademy, type AcademyAnswer, type AcademyArticleRef } from '@/lib/apiClient'
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
        if (span.code) return <code key={i} className="tms-code tms-code-inline">{span.text}</code>
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
          return <Tag key={i}><Spans spans={block.spans} /></Tag>
        }
        if (block.kind === 'paragraph') {
          return <p key={i}><Spans spans={block.spans} /></p>
        }
        if (block.kind === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul'
          return (
            <Tag key={i}>
              {block.items.map((item, j) => <li key={j}><Spans spans={item} /></li>)}
            </Tag>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre key={i} className="tms-code"><code>{block.text}</code></pre>
          )
        }
        return (
          <table key={i} className="tms-table">
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

function buildArticleRefs(): AcademyArticleRef[] {
  const refs: AcademyArticleRef[] = []
  for (const [path, source] of Object.entries(FILES)) {
    const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
    if (file.toLowerCase() === 'readme') continue
    const { data } = parseFrontMatter(source)
    refs.push({ slug: data.slug || file, title: data.title || file, content: source })
  }
  return refs
}

function AskPanel() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AcademyAnswer | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canAsk = question.trim().length > 0 && !loading

  const submit = async () => {
    if (!canAsk) return
    setLoading(true)
    setError(null)
    setAnswer(null)
    try {
      const result = await askAcademy(question.trim(), buildArticleRefs())
      setAnswer(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the assistant')
    } finally {
      setLoading(false)
    }
  }

  return (
    <TmsCard title="Ask the Academy">
      <p className="tms-muted tms-academy-lede">
        Ask a question about BCAT Ops and the TMS. The assistant answers only from the
        Academy articles shown below and cites the ones it used.
      </p>
      <TmsField label="Your question">
        <TmsTextarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How do I release a shipment to accounting?"
          rows={3}
        />
      </TmsField>
      <div className="tms-academy-ask-actions">
        <TmsButton onClick={submit} disabled={!canAsk}>
          Ask
        </TmsButton>
      </div>
      {error ? <p className="tms-field-error tms-academy-error">{error}</p> : null}
      {answer ? (
        <div className="tms-academy-answer">
          <p>{answer.answer}</p>
          {answer.citations.length > 0 ? (
            <div className="tms-academy-cited">
              Cited: {answer.citations.map((slug, i) => (
                <span key={slug}>
                  {i > 0 ? ', ' : ''}
                  <Link to={`/tms/academy/${slug}`}>{slug}</Link>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </TmsCard>
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
          <p className="tms-academy-back"><Link to="/tms/academy">Back to the Academy</Link></p>
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
      <div className="tms-academy-index">
        <AskPanel />
        <TmsCard title={`${ARTICLES.length} articles`}>
          <p className="tms-muted tms-academy-lede">
            How this TMS works, written against the build you are running.
          </p>
          <ul className="tms-academy-list">
            {ARTICLES.map((article) => (
              <li key={article.slug}>
                <Link to={`/tms/academy/${article.slug}`} className="tms-academy-link">{article.title}</Link>
                {article.category ? <span className="tms-muted tms-academy-category">{article.category}</span> : null}
                {article.summary ? (
                  <div className="tms-muted tms-academy-summary">{article.summary}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </TmsCard>
      </div>
    </TmsPage>
  )
}

export default AcademyPage
