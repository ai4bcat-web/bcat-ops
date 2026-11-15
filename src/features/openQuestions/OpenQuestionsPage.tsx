import { useCallback, useEffect, useMemo, useState } from 'react'
import './openQuestions.css'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsEmptyState, TmsInput, TmsScrollPage, TmsSegmentedTabs, TmsSelect, TmsTextarea } from '@/features/tms/kit'
import { useAuthUser } from '@/hooks/useAuth'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import { listOpenQuestionRows, updateOpenQuestionRow } from '@/lib/openQuestionsClient'
import {
  AREA_LABEL, appendNote, countByStatus, filterQuestions, sortQuestions, statusFor, toOpenQuestion, whoFromEmail,
  type OpenQuestion, type OpenQuestionArea, type OpenQuestionFilter, type OpenQuestionRef,
} from './openQuestions'

const AREA_OPTIONS: Array<{ value: OpenQuestionArea | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All areas' },
  ...(Object.keys(AREA_LABEL) as OpenQuestionArea[]).map((a) => ({ value: a, label: AREA_LABEL[a] })),
]

function RefLine({ r }: { r: OpenQuestionRef }) {
  return (
    <li className="oq-ref">
      {r.shipmentId
        ? <Link to={shipmentEditorPath(r.shipmentId)} className="oq-pro">{r.pro}</Link>
        : <span className="oq-pro">{r.pro}</span>}
      {r.party ? <span>{r.party}</span> : null}
      {r.amount ? <span className="oq-amount">{r.amount}</span> : null}
      {r.billId ? <Link to={`/tms/invoicing/payable/bills/${encodeURIComponent(r.billId)}`} className="oq-link">Bill</Link> : null}
      {r.invoiceId ? <Link to={`/tms/invoicing/invoices/${encodeURIComponent(r.invoiceId)}`} className="oq-link">Invoice</Link> : null}
      {r.note ? <span className="tms-muted">{r.note}</span> : null}
    </li>
  )
}

function QuestionCard({ item, who, onSaved }: { item: OpenQuestion; who: string; onSaved: (next: OpenQuestion) => void }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const { details: d } = item
  const resolved = item.status === 'RESOLVED'

  const save = async (resolve: boolean | null) => {
    const notes = appendNote(item.notes, answer, who)
    const patch: { adminNotes?: string; status?: ReturnType<typeof statusFor> } = {}
    if (notes !== item.notes) patch.adminNotes = notes
    if (resolve !== null) patch.status = statusFor(resolve)
    if (!patch.adminNotes && !patch.status) return
    setBusy(true)
    try {
      onSaved(toOpenQuestion(await updateOpenQuestionRow(item.id, patch)))
      setAnswer('')
      toast.success(resolve === true ? 'Marked resolved' : resolve === false ? 'Reopened' : 'Answer saved')
    } catch {
      toast.error('Could not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TmsCard
      className="oq-card"
      title={<span className="oq-title">{item.question}</span>}
      actions={
        <span className="oq-tags">
          <TmsBadge tone="gray">{AREA_LABEL[d.area]}</TmsBadge>
          <TmsBadge tone={resolved ? 'green' : 'orange'}>{resolved ? 'Resolved' : 'Open'}</TmsBadge>
        </span>
      }
    >
      <div className="oq-body">
        {d.refs.length ? <ul className="oq-refs">{d.refs.map((r, i) => <RefLine key={`${r.pro}-${i}`} r={r} />)}</ul> : null}
        {d.aljex || d.bcat ? (
          <dl className="oq-compare">
            {d.aljex ? <><dt>Aljex</dt><dd>{d.aljex}</dd></> : null}
            {d.bcat ? <><dt>BCAT Ops</dt><dd>{d.bcat}</dd></> : null}
          </dl>
        ) : null}
        {d.context ? <p className="oq-context">{d.context}</p> : null}
        {item.notes ? (
          <div className="oq-notes">
            <div className="oq-label">Answers</div>
            <p>{item.notes}</p>
          </div>
        ) : null}
        <label className="oq-label" htmlFor={`oq-answer-${item.id}`}>{resolved ? 'Add a note' : 'Your answer'}</label>
        <TmsTextarea
          id={`oq-answer-${item.id}`}
          rows={2}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={resolved ? 'Anything to add' : 'What should happen here?'}
        />
        <div className="oq-actions">
          <TmsButton size="sm" disabled={busy || !answer.trim()} onClick={() => void save(null)}>Save answer</TmsButton>
          {resolved
            ? <TmsButton size="sm" variant="ghost" disabled={busy} onClick={() => void save(false)}>Reopen</TmsButton>
            : <TmsButton size="sm" variant="primary" disabled={busy} onClick={() => void save(true)}>{answer.trim() ? 'Save and resolve' : 'Mark resolved'}</TmsButton>}
        </div>
        {d.source ? <div className="tms-muted oq-source">From: {d.source}</div> : null}
      </div>
    </TmsCard>
  )
}

/** Accounting → Open questions: what Claude needs Ryne to decide, one card per question. */
export function OpenQuestionsPage() {
  const user = useAuthUser()
  const [items, setItems] = useState<OpenQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<OpenQuestionFilter>('OPEN')
  const [area, setArea] = useState<OpenQuestionArea | 'ALL'>('ALL')
  const [query, setQuery] = useState('')

  const load = useCallback(() => {
    listOpenQuestionRows()
      .then((rows) => setItems(rows.map(toOpenQuestion)))
      .catch(() => toast.error('Could not load the open questions'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const counts = useMemo(() => countByStatus(items), [items])
  const visible = useMemo(() => sortQuestions(filterQuestions(items, { status, area, query })), [items, status, area, query])
  const who = whoFromEmail(user?.email)
  const replace = (next: OpenQuestion) => setItems((prev) => prev.map((it) => (it.id === next.id ? next : it)))

  return (
    <TmsScrollPage
      title="Open questions"
      subtitle="Things Claude needs you to decide. Answer here and mark each one resolved."
      actions={<TmsButton size="sm" onClick={() => { setLoading(true); load() }} disabled={loading}>Refresh</TmsButton>}
      toolbar={
        <div className="oq-toolbar">
          <TmsSegmentedTabs
            aria-label="Status"
            size="sm"
            active={status}
            onSelect={(k) => setStatus(k as OpenQuestionFilter)}
            tabs={[
              { key: 'OPEN', label: 'Open', count: counts.open },
              { key: 'RESOLVED', label: 'Resolved', count: counts.resolved },
              { key: 'ALL', label: 'All', count: items.length },
            ]}
          />
          <TmsSelect aria-label="Area" value={area} onChange={(e) => setArea(e.target.value as OpenQuestionArea | 'ALL')} options={AREA_OPTIONS} />
          <TmsInput aria-label="Search" placeholder="Search PRO, carrier, text" value={query} onChange={(e) => setQuery(e.target.value)} className="oq-search" />
        </div>
      }
    >
      {loading && items.length === 0 ? (
        <p className="tms-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <TmsEmptyState title={status === 'OPEN' ? 'No open questions.' : 'Nothing matches these filters.'} />
      ) : (
        <div className="oq-list">
          {visible.map((it) => <QuestionCard key={it.id} item={it} who={who} onSaved={replace} />)}
        </div>
      )}
    </TmsScrollPage>
  )
}

export default OpenQuestionsPage
