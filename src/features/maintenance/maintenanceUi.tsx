// Shared UI primitives for the Maintenance + Invoices pages (redesign look).
/* eslint-disable react-refresh/only-export-components -- shared style consts + primitives live together here by design */
import type { CSSProperties, ReactNode } from 'react'
import { X } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isOverdue(dateStr?: string): boolean {
  if (!dateStr) return false
  return new Date(dateStr).getTime() < Date.now()
}

export function formatCents(cents: number) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Table styling (matches redesign .tbl) ───────────────────────────────────────

export const thBase: CSSProperties = {
  position: 'sticky', top: 0, zIndex: 1, background: 'var(--ds-bg-2)', fontSize: 11, fontWeight: 500,
  color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '11px 14px',
  borderBottom: '1px solid var(--ds-border)', whiteSpace: 'nowrap',
}
export const tdBase: CSSProperties = {
  padding: '15px 14px', borderBottom: '1px solid var(--ds-border)', fontSize: 13, color: 'var(--ds-t1)', verticalAlign: 'middle',
}
export const equipChipStyle: CSSProperties = {
  display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500,
  background: '#f1f5f9', color: 'var(--ds-t2)', padding: '2px 7px', borderRadius: 5,
}
export const iconBtnStyle: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 5, borderRadius: 6 }

// ── Pill ─────────────────────────────────────────────────────────────────────

export type PillTone = 'bad' | 'warn' | 'ok' | 'blue' | 'violet' | 'neutral'
const PILL_TONE: Record<PillTone, { bg: string; fg: string }> = {
  bad:     { bg: 'var(--ds-red-bg)',    fg: 'var(--ds-red)' },
  warn:    { bg: 'var(--ds-amber-bg)',  fg: 'var(--ds-amber)' },
  ok:      { bg: 'var(--ds-green-bg)',  fg: 'var(--ds-green)' },
  blue:    { bg: 'var(--ds-blue-bg)',   fg: 'var(--ds-blue-dark)' },
  violet:  { bg: '#efe7fd',             fg: '#6d28d9' },
  neutral: { bg: 'var(--ds-bg-2)',      fg: 'var(--ds-t2)' },
}

export function Pill({ tone, dot, children }: { tone: PillTone; dot?: boolean; children: ReactNode }) {
  const t = PILL_TONE[tone]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap', background: t.bg, color: t.fg }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />}
      {children}
    </span>
  )
}

// ── Form primitives ─────────────────────────────────────────────────────────────

export const inputStyle: CSSProperties = {
  width: '100%', background: 'var(--ds-surface)', border: '1px solid var(--ds-border-strong)',
  borderRadius: 9, padding: '8px 12px', color: 'var(--ds-t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
}

export function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--ds-t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        {label}{required && <span style={{ color: 'var(--ds-red)' }}> *</span>}
      </div>
      {children}
    </div>
  )
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ds-t2)', letterSpacing: '0.01em', paddingBottom: 8, borderBottom: '1px solid var(--ds-border)' }}>{title}</div>
      {children}
    </section>
  )
}

interface SegOption<T> { value: T; label: string }
export function Seg<T extends string>({ options, value, onChange }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', background: 'var(--ds-bg-2)', border: '1px solid var(--ds-border)', borderRadius: 10, padding: 3, gap: 2 }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              flex: 1, padding: '7px 10px', borderRadius: 7, border: 'none', fontSize: 12.5, fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              background: active ? 'var(--ds-surface)' : 'transparent',
              color: active ? 'var(--ds-t1)' : 'var(--ds-t2)',
              boxShadow: active ? 'var(--sh-sm), inset 0 0 0 1px var(--ds-border)' : 'none',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Buttons ─────────────────────────────────────────────────────────────────────

export const btnBase: CSSProperties = { height: 36, padding: '0 16px', borderRadius: 9, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }
export const btnGhost: CSSProperties = { ...btnBase, background: 'var(--ds-surface)', border: '1px solid var(--ds-border-strong)', color: 'var(--ds-t1)', fontWeight: 500 }
export const btnPrimary: CSSProperties = { ...btnBase, background: 'var(--ds-blue)', border: '1px solid var(--ds-blue)', color: '#fff' }
export const btnDanger: CSSProperties = { ...btnBase, background: 'transparent', border: '1px solid transparent', color: 'var(--ds-red)', fontWeight: 500 }

// ── Centered modal shell — generous padding, scrolls, footer pinned ─────────────

export function Modal({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  return (
    <div
      onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.32)', backdropFilter: 'blur(2px)', padding: 24 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: 'min(540px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: 16, boxShadow: 'var(--sh-lg)', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--ds-border)', flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
          <button aria-label="Close" onClick={onClose} style={{ ...iconBtnStyle, color: 'var(--ds-t3)', display: 'flex' }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 24px' }}>{children}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 24px', borderTop: '1px solid var(--ds-border)', background: 'var(--ds-bg)', flexShrink: 0 }}>{footer}</div>
      </div>
    </div>
  )
}
