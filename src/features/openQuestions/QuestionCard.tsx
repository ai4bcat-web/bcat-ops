/**
 * One open question: what it is about, what Aljex and BCAT Ops each say, the answers so far, and the box
 * to answer or resolve it. Shown from Needs review on Accounts Receivable and Accounts Payable
 * (Ryne 2026-11-16: the Open questions tab was folded into Needs review).
 */
import { useState } from 'react'
import './openQuestions.css'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsCard, TmsTextarea } from '@/features/tms/kit'
import { shipmentEditorPath } from '@/lib/shipmentLinks'
import { updateOpenQuestionRow } from '@/lib/openQuestionsClient'
import { AREA_LABEL, appendNote, statusFor, toOpenQuestion, type OpenQuestion, type OpenQuestionRef } from './openQuestions'

export function RefLine({ r }: { r: OpenQuestionRef }) {
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

export function QuestionCard({ item, who, onSaved }: { item: OpenQuestion; who: string; onSaved: (next: OpenQuestion) => void }) {
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
