// Shared UI primitives for the Maintenance + Invoices pages (redesign look).
/* eslint-disable react-refresh/only-export-components -- shared style consts + primitives live together here by design */
import type { CSSProperties, ReactNode } from 'react'
import { TmsBadge } from '@/features/tms/kit/TmsBadge'
import type { TmsTone } from '@/features/tms/kit/TmsBadge'
import { TmsDialog } from '@/features/tms/kit/TmsDialog'

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
  position: 'sticky', top: 0, zIndex: 1, background: 'var(--tms-surface)', fontSize: 11, fontWeight: 500,
  color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '11px 14px',
  borderBottom: '1px solid var(--tms-border)', whiteSpace: 'nowrap',
}
export const tdBase: CSSProperties = {
  padding: '15px 14px', borderBottom: '1px solid var(--tms-border)', fontSize: 13, color: 'var(--tms-text)', verticalAlign: 'middle',
}
export const equipChipStyle: CSSProperties = {
  display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500,
  background: 'var(--tms-surface)', color: 'var(--tms-text-2)', padding: '2px 7px', borderRadius: 5,
}
export const iconBtnStyle: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', padding: 5, borderRadius: 6 }

// ── Pill ─────────────────────────────────────────────────────────────────────

export type PillTone = 'bad' | 'warn' | 'ok' | 'blue' | 'violet' | 'neutral'
const PILL_TONE: Record<PillTone, TmsTone> = {
  bad: 'red',
  warn: 'orange',
  ok: 'green',
  blue: 'blue',
  violet: 'purple',
  neutral: 'gray',
}

export function Pill({ tone, dot, children }: { tone: PillTone; dot?: boolean; children: ReactNode }) {
  return (
    <TmsBadge tone={PILL_TONE[tone]}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />}
      {children}
    </TmsBadge>
  )
}

// ── Form primitives ─────────────────────────────────────────────────────────────

export const inputStyle: CSSProperties = {
  width: '100%', background: 'var(--tms-card)', border: '1px solid var(--tms-input-border)',
  borderRadius: 9, padding: '8px 12px', color: 'var(--tms-text)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
}

export function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--tms-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
        {label}{required && <span style={{ color: 'var(--tms-badge-red)' }}> *</span>}
      </div>
      {children}
    </div>
  )
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tms-text-2)', letterSpacing: '0.01em', paddingBottom: 8, borderBottom: '1px solid var(--tms-border)' }}>{title}</div>
      {children}
    </section>
  )
}

interface SegOption<T> { value: T; label: string }
export function Seg<T extends string>({ options, value, onChange }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', background: 'var(--tms-surface)', border: '1px solid var(--tms-border)', borderRadius: 10, padding: 3, gap: 2 }}>
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
              background: active ? 'var(--tms-card)' : 'transparent',
              color: active ? 'var(--tms-text)' : 'var(--tms-text-2)',
              boxShadow: active ? 'var(--tms-shadow), inset 0 0 0 1px var(--tms-border)' : 'none',
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
export const btnGhost: CSSProperties = { ...btnBase, background: 'var(--tms-card)', border: '1px solid var(--tms-input-border)', color: 'var(--tms-text)', fontWeight: 500 }
export const btnPrimary: CSSProperties = { ...btnBase, background: 'var(--tms-primary)', border: '1px solid var(--tms-primary)', color: 'var(--tms-on-primary)' }
export const btnDanger: CSSProperties = { ...btnBase, background: 'transparent', border: '1px solid transparent', color: 'var(--tms-badge-red)', fontWeight: 500 }

// ── Centered modal shell — generous padding, scrolls, footer pinned ─────────────

export function Modal({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  return (
    <TmsDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title={title}
      footer={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%' }}>{footer}</div>}
    >
      {children}
    </TmsDialog>
  )
}
