import { useState } from 'react'
import { X, FileStack } from 'lucide-react'
import type { PacketField, PacketItem } from '@/lib/filePacketPdf'

/**
 * Choose what goes in a packet, without cluttering the common path.
 *
 * "Download packet" still builds everything in one click — this only opens from the
 * small "Choose…" link beside it, for the times you need to send an insurer the truck
 * paperwork but not the driver's licence.
 *
 * Everything starts ticked, so the default is the same packet you'd have got anyway and
 * the picker can only ever subtract.
 */
export function PacketPickerModal({
  title, fields, items, missing = [], onCancel, onBuild,
}: {
  title: string
  fields: PacketField[]
  items: PacketItem[]
  /**
   * Slots with nothing uploaded. Listed but not selectable, so the picker shows the
   * COMPLETE set of documents this asset should carry — otherwise a truck with three
   * uploads offers three options and gives no hint the other six exist.
   */
  missing?: string[]
  onCancel: () => void
  onBuild: (chosen: { fieldLabels: string[]; itemLabels: string[] }) => void
}) {
  const [omittedFields, setOmittedFields] = useState<Set<string>>(new Set())
  const [omittedItems, setOmittedItems] = useState<Set<string>>(new Set())

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key); else next.add(key)
    apply(next)
  }

  const chosenFields = fields.filter((f) => !omittedFields.has(f.label))
  const chosenItems = items.filter((i) => !omittedItems.has(i.label))

  const row = (label: string, sub: string | undefined, checked: boolean, onChange: () => void) => (
    <label key={label}
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', fontSize: 12.5, color: 'var(--ds-t1)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {sub && <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{sub}</span>}
    </label>
  )

  return (
    <div onClick={onCancel}
      style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--ds-surface)', borderRadius: 14, width: 460, maxWidth: '94vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--ds-border)' }}>
          <FileStack size={16} style={{ color: 'var(--ds-t3)' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ds-t1)' }}>What goes in the packet?</div>
            <div style={{ fontSize: 11.5, color: 'var(--ds-t3)' }}>{title}</div>
          </div>
          <button onClick={onCancel} aria-label="Close" style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={17} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Details on the cover</div>
          {fields.map((f) => row(f.label, f.value || '—', !omittedFields.has(f.label),
            () => toggle(omittedFields, f.label, setOmittedFields)))}

          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 4px' }}>Documents</div>
          {items.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Nothing on file yet — the packet will be just the cover sheet.</div>
            : items.map((i) => row(i.label, i.note, !omittedItems.has(i.label),
                () => toggle(omittedItems, i.label, setOmittedItems)))}

          {missing.length > 0 && (
            <>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 4px' }}>
                Not on file
              </div>
              {missing.map((label) => (
                <div key={label}
                  title="Nothing uploaded for this yet, so it can't go in the packet"
                  style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', fontSize: 12.5, color: 'var(--ds-t3)' }}>
                  <input type="checkbox" checked={false} disabled readOnly />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                  <span style={{ fontSize: 11 }}>missing</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px', borderTop: '1px solid var(--ds-border)' }}>
          <span style={{ flex: 1, fontSize: 11.5, color: 'var(--ds-t3)' }}>
            {chosenItems.length} of {items.length} document{items.length !== 1 ? 's' : ''}
          </span>
          <button onClick={onCancel}
            style={{ height: 32, padding: '0 14px', borderRadius: 8, border: '1px solid var(--ds-border)', background: 'var(--ds-bg)', color: 'var(--ds-t2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={() => onBuild({
              fieldLabels: chosenFields.map((f) => f.label),
              itemLabels: chosenItems.map((i) => i.label),
            })}
            style={{ height: 32, padding: '0 16px', borderRadius: 8, border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            Build PDF
          </button>
        </div>
      </div>
    </div>
  )
}
