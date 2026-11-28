import { useMemo, useState } from 'react'
import { Ban, Pencil } from 'lucide-react'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { US_STATES } from '@/lib/capacityBoard'

const NAME_BY_CODE = new Map(US_STATES.map((s) => [s.code, s.name]))

/**
 * The strip across the top of the Capacity board naming the states we do not travel to. It is one list for the whole board, so it
 * applies to every truck, and the same list shows on each card. Anyone who can edit cards can edit it.
 */
export function CapacityNoGoStrip({ states, onSave, phone }: {
  states: readonly string[]
  /** Save the new list; true once the server has it. */
  onSave: (next: string[]) => Promise<boolean>
  phone: boolean
}) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="cap-nogo" data-testid="capacity-nogo" role="group" aria-label="States we do not travel to" style={{ padding: phone ? '8px' : '8px 14px' }}>
      <span className="cap-nogo-label"><Ban size={13} aria-hidden="true" /> We do not travel to:</span>
      {states.length === 0 ? (
        <span className="cap-nogo-empty">No states excluded</span>
      ) : (
        <span className="cap-nogo-list">
          {states.map((code) => <span key={code} className="cap-nogo-chip" title={NAME_BY_CODE.get(code) ?? code}>{code}</span>)}
        </span>
      )}
      <button type="button" className="cap-btn cap-nogo-edit" onClick={() => setEditing(true)} aria-label="Edit states we do not travel to">
        <Pencil size={12} aria-hidden="true" /> Edit
      </button>
      {editing && <NoGoPicker states={states} onSave={onSave} onClose={() => setEditing(false)} />}
    </div>
  )
}

function NoGoPicker({ states, onSave, onClose }: { states: readonly string[]; onSave: (next: string[]) => Promise<boolean>; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(states))
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => US_STATES.filter((s) => !q || s.code.toLowerCase() === q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().startsWith(q)), [q])

  const toggle = (code: string) => setPicked((cur) => {
    const next = new Set(cur)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    return next
  })

  async function submit() {
    setSaving(true)
    try {
      if (await onSave([...picked].sort())) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="States we do not travel to"
      description="This list applies to every truck on the board, and it shows on every card."
      footer={(
        <>
          <TmsButton variant="ghost" onClick={onClose}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => void submit()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</TmsButton>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="search" aria-label="Search states" placeholder="Search states…" value={query} onChange={(e) => setQuery(e.target.value)}
            style={{ flex: '1 1 160px', height: 32, padding: '0 10px', borderRadius: 7, border: '1px solid var(--tms-border)', background: 'var(--tms-bg)', color: 'var(--tms-text)', fontSize: 13, fontFamily: 'inherit' }}
          />
          <TmsButton variant="ghost" onClick={() => setPicked((cur) => new Set([...cur, ...shown.map((s) => s.code)]))}>Select shown</TmsButton>
          <TmsButton variant="ghost" onClick={() => setPicked(new Set())}>Clear all</TmsButton>
        </div>
        <div style={{ fontSize: 12, color: 'var(--tms-muted)' }} aria-live="polite">{picked.size === 0 ? 'No states selected' : `${picked.size} selected`}</div>
        <div className="cap-nogo-grid" role="group" aria-label="States">
          {shown.map((s) => (
            <button
              key={s.code} type="button" className="cap-nogo-toggle" aria-pressed={picked.has(s.code)} onClick={() => toggle(s.code)} title={s.name}
            >
              <strong>{s.code}</strong><span>{s.name}</span>
            </button>
          ))}
          {shown.length === 0 && <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: 12.5, color: 'var(--tms-muted)' }}>No state matches "{query}".</p>}
        </div>
      </div>
    </TmsDialog>
  )
}
