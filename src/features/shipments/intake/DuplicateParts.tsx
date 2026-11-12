/**
 * The Intake duplicate affordances: the delete confirm (owner/ADMIN), the "Possible duplicate" / "Already built" notices, the team notes,
 * and the compact row flags that open them in one dialog (Ryne 2026-11-12: queue rows stay one line; deleting and clearing a flag are
 * admin calls, everyone else leaves a note). Used by the queue rows and the review page.
 */
import { useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { TmsBadge, TmsButton, TmsDialog, TmsTextarea } from '@/features/tms/kit'
import { addIntakeNote, deleteIntake, markIntakeNotDuplicate } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/date'
import { intakeRowLabel, type DuplicateInfo } from '@/lib/intakeDuplicates'
import type { BuiltMatch } from '@/lib/intakeBuilt'
import type { IntakeLoadRecord } from '@/types/intake'

export function DeleteIntakeDialog({ row, open, onOpenChange, onDeleted }: {
  row: IntakeLoadRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (row: IntakeLoadRecord) => void
}) {
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const done = await deleteIntake({ intakeId: row.id, expectedVersion: row.version })
      toast.success('Deleted from Intake')
      onOpenChange(false)
      onDeleted(done)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }
  return (
    <TmsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this load from Intake?"
      description={`${intakeRowLabel(row)}. It is removed from Intake only: a shipment already built from it is not touched, and repeat e-mails for it will not bring it back.`}
      footer={(
        <div className="tms-intake-footer">
          <TmsButton size="sm" onClick={() => onOpenChange(false)}>Cancel</TmsButton>
          <TmsButton size="sm" variant="destructive" data-testid="intake-delete-confirm" disabled={busy} onClick={() => { void run() }}>Delete</TmsButton>
        </div>
      )}
    >
      {null}
    </TmsDialog>
  )
}

/** "Possible duplicate. Delete this one?" with who the other row is; owner/ADMIN get the delete and "Not a duplicate". */
export function DuplicateNotice({ row, info, isAdmin, onDelete, onChanged }: {
  row: IntakeLoadRecord
  info: DuplicateInfo
  isAdmin: boolean
  onDelete: () => void
  onChanged: (row: IntakeLoadRecord) => void
}) {
  const [busy, setBusy] = useState(false)
  const other = info.isOriginal ? info.otherIds[0] : info.originalId
  async function notDuplicate() {
    setBusy(true)
    try {
      onChanged(await markIntakeNotDuplicate({ intakeId: row.id, expectedVersion: row.version }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tms-intake-dup" data-testid="intake-dup-notice" onClick={(e) => e.stopPropagation()}>
      <TmsBadge tone="orange">Possible duplicate</TmsBadge>
      <span className="tms-intake-dup-q">
        {info.isOriginal ? `Same as ${info.count - 1} later e-mail${info.count - 1 === 1 ? '' : 's'}. ` : `Same as ${info.originalLabel}. `}
        Delete this one?
      </span>
      {other ? <Link className="tms-intake-dup-link" to={`/tms/shipments/intake/${encodeURIComponent(other)}`}>{info.isOriginal ? 'See the other' : 'See the original'}</Link> : null}
      {isAdmin ? <TmsButton size="sm" variant="destructive" data-testid="intake-dup-delete" disabled={busy} onClick={onDelete}>Delete duplicate</TmsButton> : null}
      {isAdmin ? <TmsButton size="sm" variant="ghost" data-testid="intake-dup-not" disabled={busy} onClick={() => { void notDuplicate() }}>Not a duplicate</TmsButton> : null}
    </div>
  )
}

const MAX_PROS_SHOWN = 3

/**
 * "Already built — PRO 20043": this e-mail's reference is already on a shipment with a PRO. A reference from the parsed fields is a firm
 * match; a number only found in the subject says "May already be built". Owner/ADMIN get "Not the same load" and the delete.
 */
export function BuiltNotice({ row, matches, isAdmin, onDelete, onChanged }: {
  row: IntakeLoadRecord
  matches: BuiltMatch[]
  isAdmin: boolean
  onDelete: () => void
  onChanged: (row: IntakeLoadRecord) => void
}) {
  const [busy, setBusy] = useState(false)
  const firm = matches.some((m) => m.source === 'reference')
  const shown = matches.slice(0, MAX_PROS_SHOWN)
  const first = matches[0]
  async function notSame() {
    setBusy(true)
    try {
      onChanged(await markIntakeNotDuplicate({ intakeId: row.id, expectedVersion: row.version }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tms-intake-dup" data-testid="intake-built-notice" onClick={(e) => e.stopPropagation()}>
      <TmsBadge tone={firm ? 'red' : 'orange'}>
        {firm ? 'Already built' : 'May already be built'}
        {' — '}
        {shown.map((m) => `PRO ${m.number}`).join(', ')}{matches.length > shown.length ? ` +${matches.length - shown.length}` : ''}
      </TmsBadge>
      <span className="tms-intake-dup-q">
        {firm ? `Reference ${first.value} is already on` : `The number ${first.value} in the subject is already on`}
        {first.customerName ? ` ${first.customerName}'s` : ' a'} shipment. Delete this one?
      </span>
      {shown.map((m) => (
        <Link key={m.shipmentId} className="tms-intake-dup-link" to={`/tms/shipments/${encodeURIComponent(m.shipmentId)}`} data-testid="intake-built-link">Open PRO {m.number}</Link>
      ))}
      {isAdmin ? <TmsButton size="sm" variant="destructive" data-testid="intake-built-delete" disabled={busy} onClick={onDelete}>Delete (already built)</TmsButton> : null}
      {isAdmin ? <TmsButton size="sm" variant="ghost" data-testid="intake-built-not" disabled={busy} onClick={() => { void notSame() }}>Not the same load</TmsButton> : null}
    </div>
  )
}

/** Who wrote a note, as a short name: the part of the e-mail before the @. */
function noteAuthor(email: string): string {
  return email.includes('@') ? email.slice(0, email.indexOf('@')) : email
}

/** The team notes on an intake row, newest last, and a box to add one (anyone who can review). */
export function IntakeNotes({ row, canReview, onChanged }: {
  row: IntakeLoadRecord
  canReview: boolean
  onChanged: (row: IntakeLoadRecord) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const notes = row.notes ?? []
  async function add() {
    const value = text.trim()
    if (!value) return
    setBusy(true)
    try {
      onChanged(await addIntakeNote({ intakeId: row.id, expectedVersion: row.version, text: value }))
      setText('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the note')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="tms-intake-notes" data-testid="intake-notes" aria-label="Notes">
      <h3 className="tms-intake-notes-title">Notes</h3>
      {notes.length === 0 ? <p className="tms-intake-notes-empty">No notes yet.</p> : (
        <ul className="tms-intake-notes-list">
          {notes.map((n, i) => (
            <li key={`${n.at}-${i}`} className="tms-intake-note" data-testid="intake-note">
              <span className="tms-intake-note-meta">{noteAuthor(n.by)} · {formatDateTime(n.at)}</span>
              <span className="tms-intake-note-text">{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      {canReview ? (
        <div className="tms-intake-note-add">
          <TmsTextarea
            aria-label="Add a note"
            data-testid="intake-note-input"
            rows={2}
            maxLength={1000}
            placeholder="Not sure about this one? Leave an update for the team."
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          <TmsButton size="sm" data-testid="intake-note-add" disabled={busy || !text.trim()} onClick={() => { void add() }}>Add note</TmsButton>
        </div>
      ) : null}
    </section>
  )
}

/**
 * The one-line flags on a queue row: compact badges for a possible duplicate or an already-built match and a note count.
 * Each opens the row's dialog, where the details, the admin actions and the notes live.
 */
export function IntakeRowFlags({ row, dup, built, onOpen }: {
  row: IntakeLoadRecord
  dup: DuplicateInfo | undefined
  built: BuiltMatch[] | undefined
  onOpen: () => void
}) {
  const notes = row.notes?.length ?? 0
  const firm = built?.some((m) => m.source === 'reference') ?? false
  const open = (e: MouseEvent) => { e.stopPropagation(); onOpen() }
  return (
    <span className="tms-intake-flags">
      {dup ? (
        <button type="button" className="tms-intake-flag" data-testid="intake-flag-dup" title={dup.isOriginal ? `Same as ${dup.count - 1} later e-mail${dup.count - 1 === 1 ? '' : 's'}` : `Same as ${dup.originalLabel}`} onClick={open}>
          <TmsBadge tone="orange">Possible duplicate</TmsBadge>
        </button>
      ) : null}
      {built && built.length > 0 ? (
        <button type="button" className="tms-intake-flag" data-testid="intake-flag-built" title={`${firm ? 'Reference' : 'A number in the subject'} ${built[0].value} is already on PRO ${built[0].number}`} onClick={open}>
          <TmsBadge tone={firm ? 'red' : 'orange'}>{firm ? 'Built' : 'May be built'}: PRO {built[0].number}{built.length > 1 ? ` +${built.length - 1}` : ''}</TmsBadge>
        </button>
      ) : null}
      <button type="button" className={`tms-intake-flag tms-intake-flag-notes${notes ? ' tms-intake-flag-has' : ''}`} data-testid="intake-flag-notes" aria-label={notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'Add a note'} title={notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'Add a note'} onClick={open}>
        <MessageSquare size={14} aria-hidden="true" />{notes ? <span>{notes}</span> : null}
      </button>
    </span>
  )
}

/** A queue row's dialog: the duplicate / already-built details with the admin actions, and the team notes. */
export function IntakeItemDialog({ row, dup, built, isAdmin, canReview, onClose, onDelete, onChanged }: {
  row: IntakeLoadRecord
  dup: DuplicateInfo | undefined
  built: BuiltMatch[] | undefined
  isAdmin: boolean
  canReview: boolean
  onClose: () => void
  onDelete: () => void
  onChanged: (row: IntakeLoadRecord) => void
}) {
  // The dialog keeps the newest copy it was handed back, so a second note in a row carries the right version.
  const [current, setCurrent] = useState(row)
  const changed = (next: IntakeLoadRecord) => { setCurrent(next); onChanged(next) }
  row = current.version >= row.version ? current : row
  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={row.subject || '(no subject)'}
      description={`${row.fromName || row.fromEmail} · ${formatDateTime(row.receivedAt)}`}
      footer={(
        <div className="tms-intake-footer">
          <Link to={`/tms/shipments/intake/${encodeURIComponent(row.id)}`}>Open the load</Link>
          {isAdmin && row.status === 'OPEN' ? <TmsButton size="sm" variant="destructive" data-testid="intake-dialog-delete" onClick={onDelete}>Delete</TmsButton> : null}
          <TmsButton size="sm" onClick={onClose}>Close</TmsButton>
        </div>
      )}
    >
      <div className="tms-intake-item">
        {dup ? <DuplicateNotice row={row} info={dup} isAdmin={isAdmin} onDelete={onDelete} onChanged={changed} /> : null}
        {built && built.length > 0 ? <BuiltNotice row={row} matches={built} isAdmin={isAdmin} onDelete={onDelete} onChanged={changed} /> : null}
        <IntakeNotes row={row} canReview={canReview} onChanged={changed} />
      </div>
    </TmsDialog>
  )
}
