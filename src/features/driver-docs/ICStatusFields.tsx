import { PenLine } from 'lucide-react'
import { IC_STATUS_STATEMENTS, type ICStatusValues } from '@/lib/driverDocs'

const inputStyle: React.CSSProperties = {
  height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--ds-border)',
  background: 'var(--ds-surface)', color: 'var(--ds-t1)', fontSize: 13.5, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
}
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5, display: 'block' }

/**
 * The fillable + signable body of the WI Independent Contractor Status form. Shared by
 * the office modal (fill on behalf) and the public /sign/:token page (driver self-signs).
 */
export function ICStatusFields({ value, onChange }: { value: ICStatusValues; onChange: (v: ICStatusValues) => void }) {
  const set = <K extends keyof ICStatusValues>(k: K, val: ICStatusValues[K]) => onChange({ ...value, [k]: val })
  const toggle = (i: number) => onChange({ ...value, initials: value.initials.map((b, j) => (j === i ? !b : b)) })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Initial <strong>“yes”</strong> on each — {value.initials.filter(Boolean).length}/14</span>
        <button
          type="button"
          onClick={() => onChange({ ...value, initials: value.initials.map(() => true) })}
          style={{ fontSize: 12, color: 'var(--ds-blue)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          Initial all
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {IC_STATUS_STATEMENTS.map((s, i) => (
          <label key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 11px', borderRadius: 8, border: `1px solid ${value.initials[i] ? 'var(--ds-blue)' : 'var(--ds-border)'}`, background: value.initials[i] ? 'var(--ds-blue-bg)' : 'var(--ds-bg)', cursor: 'pointer' }}>
            <input type="checkbox" checked={value.initials[i]} onChange={() => toggle(i)} style={{ marginTop: 3, flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: 'var(--ds-t1)', lineHeight: 1.45 }}><strong>{i + 1}.</strong> {s}</span>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><span style={label}>Print / Type Name</span><input style={inputStyle} value={value.printName} onChange={(e) => set('printName', e.target.value)} /></div>
        <div><span style={label}>Date</span><input type="date" style={inputStyle} value={value.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div><span style={label}>Federal Employer Tax ID (EIN)</span><input style={inputStyle} value={value.ein} onChange={(e) => set('ein', e.target.value)} placeholder="XX-XXXXXXX" /></div>
        <div><span style={label}>Signature (type full name)</span><input style={{ ...inputStyle, fontStyle: 'italic' }} value={value.signature} onChange={(e) => set('signature', e.target.value)} placeholder="e.g. John A. Smith" /></div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--ds-t3)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
        <PenLine size={12} /> Typing your full name above is a legally binding electronic signature, timestamped on submit.
      </p>
    </div>
  )
}
