import { useState } from 'react'
import { toast } from 'sonner'

/**
 * A date input that only writes when Save is clicked. Typing a date fires onChange for
 * every partial year ("0002", "0020", …), so saving on change raced writes against each
 * other and the last one to land won. Save awaits the real write, toasts its real result,
 * and a failed write leaves the draft in place. Clearing sends `null` (undefined is
 * dropped by the GraphQL client, so a clear never saved).
 */
export function DraftDateField({ value, onSave, label, title, successMessage, clearedMessage, compact = false }: {
  /** The saved value, YYYY-MM-DD. */
  value: string | null | undefined
  onSave: (next: string | null) => Promise<void>
  /** Names the field in the failure toast. */
  label: string
  title?: string
  successMessage: string
  clearedMessage: string
  compact?: boolean
}) {
  const saved = value ?? ''
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  // A different record, or a save landing from elsewhere, resets the draft.
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) { setSeen(saved); setDraft(saved) }

  const dirty = draft !== saved

  const save = async () => {
    setBusy(true)
    try {
      await onSave(draft || null)
      toast.success(draft ? successMessage : clearedMessage)
    } catch (err) {
      toast.error(`Couldn't save ${label}: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  const inputStyle = compact
    ? { height: 28, width: '100%', borderRadius: 6, padding: '0 6px', fontSize: 11.5, background: 'var(--ds-bg)' }
    : { height: 34, borderRadius: 8, padding: '0 10px', fontSize: 13, background: 'var(--ds-surface)' }
  const btn = { height: compact ? 24 : 30, padding: '0 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' } as const

  return (
    <div>
      <input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} title={title} aria-label={label} disabled={busy}
        style={{ ...inputStyle, border: '1px solid var(--ds-border)', color: 'var(--ds-t1)', fontFamily: 'inherit', boxSizing: 'border-box' }} />
      {dirty && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button type="button" onClick={() => void save()} disabled={busy}
            style={{ ...btn, border: 'none', background: 'var(--ds-blue)', color: '#fff', opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => setDraft(saved)} disabled={busy}
            style={{ ...btn, border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)' }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
