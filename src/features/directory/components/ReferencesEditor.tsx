import { Plus, Trash2 } from 'lucide-react'
import { TmsButton, TmsField, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { RequiredReference, ReferenceLevel } from '@/types/tms'

const LEVELS: ReferenceLevel[] = ['ORDER', 'HANDLING_UNIT', 'PACKAGE', 'STOP']

function emptyReference(): RequiredReference {
  return { code: '', level: 'ORDER', display: true, countOnNewOrder: 0 }
}

interface ReferencesEditorProps {
  references: RequiredReference[]
  onChange: (references: RequiredReference[]) => void
  disabled?: boolean
}

/**
 * The reference numbers a shipment must carry before accounting may release it. The
 * semantics are the release gate's, not a display preference — the labels say so.
 */
export function ReferencesEditor({ references, onChange, disabled }: ReferencesEditorProps) {
  const update = (idx: number, patch: Partial<RequiredReference>) => {
    onChange(references.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  const add = () => onChange([...references, emptyReference()])
  const remove = (idx: number) => onChange(references.filter((_, i) => i !== idx))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {references.length === 0 && <p className="tms-muted" style={{ fontSize: 12 }}>No required references configured.</p>}
      {references.map((r, idx) => (
        <div key={idx} className="tms-card">
          <div className="tms-card-body tms-grid tms-grid-4" style={{ alignItems: 'flex-end' }}>
            <TmsField label="Code">
              <TmsInput value={r.code} onChange={(e) => update(idx, { code: e.target.value })} disabled={disabled} />
            </TmsField>
            <TmsField label="Label">
              <TmsInput value={r.label ?? ''} onChange={(e) => update(idx, { label: e.target.value })} disabled={disabled} />
            </TmsField>
            <TmsField label="Level">
              <TmsSelect
                value={r.level}
                onChange={(e) => update(idx, { level: e.target.value as ReferenceLevel })}
                disabled={disabled}
                options={LEVELS.map((l) => ({ value: l, label: l }))}
              />
            </TmsField>
            <TmsField label="# on a new shipment">
              <TmsInput
                type="number"
                min={0}
                max={10}
                value={r.countOnNewOrder}
                onChange={(e) => update(idx, { countOnNewOrder: Math.min(10, Math.max(0, Number(e.target.value))) })}
                disabled={disabled}
              />
            </TmsField>
            <label className="tms-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={r.display}
                onChange={(e) => update(idx, { display: e.target.checked })}
                disabled={disabled}
              />
              Show
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <TmsButton variant="ghost" size="sm" aria-label="Remove reference" onClick={() => remove(idx)} disabled={disabled}>
                <Trash2 size={14} />
              </TmsButton>
            </div>
          </div>
        </div>
      ))}
      <TmsButton size="sm" onClick={add} disabled={disabled}>
        <Plus size={14} /> Add reference
      </TmsButton>
    </div>
  )
}
