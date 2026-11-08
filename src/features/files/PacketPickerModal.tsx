import { useState } from 'react'
import { TmsButton } from '@/features/tms/kit/TmsButton'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'
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
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', fontSize: 12.5, color: 'var(--tms-text)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {sub && <span style={{ fontSize: 11, color: 'var(--tms-muted)' }}>{sub}</span>}
    </label>
  )

  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onCancel() }}
      title="What goes in the packet?"
      description={title}
      footer={(
        <>
          <span style={{ marginRight: 'auto', fontSize: 11.5, color: 'var(--tms-muted)' }}>
            {chosenItems.length} of {items.length} document{items.length !== 1 ? 's' : ''}
          </span>
          <TmsButton onClick={onCancel}>Cancel</TmsButton>
          <TmsButton variant="primary" onClick={() => onBuild({
            fieldLabels: chosenFields.map((f) => f.label),
            itemLabels: chosenItems.map((i) => i.label),
          })}>
            Build PDF
          </TmsButton>
        </>
      )}
    >
    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Details on the cover</div>
    {fields.map((f) => row(f.label, f.value || '—', !omittedFields.has(f.label),
      () => toggle(omittedFields, f.label, setOmittedFields)))}

    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 4px' }}>Documents</div>
    {items.length === 0
      ? <div style={{ fontSize: 12, color: 'var(--tms-muted)' }}>Nothing on file yet — the packet will be just the cover sheet.</div>
      : items.map((i) => row(i.label, i.note, !omittedItems.has(i.label),
          () => toggle(omittedItems, i.label, setOmittedItems)))}

    {missing.length > 0 && (
      <>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 4px' }}>
          Not on file
        </div>
        {missing.map((label) => (
          <div key={label}
            title="Nothing uploaded for this yet, so it can't go in the packet"
            style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', fontSize: 12.5, color: 'var(--tms-muted)' }}>
            <input type="checkbox" checked={false} disabled readOnly />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            <span style={{ fontSize: 11 }}>missing</span>
          </div>
        ))}
      </>
    )}
    </TmsDialog>
  )
}
