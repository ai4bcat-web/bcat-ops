import { X } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The right-hand panel shell used across the Files hub.
 *
 * Extracted so the driver file and the driver editor are visibly the same object —
 * same width, background, header treatment, padding and close affordance. They were
 * built separately (one hand-rolled, one a Radix Sheet with its own white background
 * and tailwind chrome) and read as two different components, which is exactly what
 * looked wrong when opening the editor from a file.
 *
 * Anything that opens beside a file should use this rather than rolling its own.
 */
export function SidePanel({
  title, subtitle, avatar, actions, footer, onClose, children, width = 620, zIndex = 50,
}: {
  title: string
  subtitle?: string
  /** Rendered left of the title — the driver's photo, typically. */
  avatar?: ReactNode
  /** Header buttons, right of the title and left of the close control. */
  actions?: ReactNode
  /** Pinned below the scroll area — save/cancel, delete. */
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
  /**
   * Raise above another panel when one opens over the other. Equal z-indexes stack two
   * dimmed backdrops and make both look broken.
   */
  zIndex?: number
}) {
  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: width, height: '100%', background: 'var(--ds-surface)',
          boxShadow: 'var(--sh-lg, -10px 0 40px rgba(0,0,0,0.2))', display: 'flex', flexDirection: 'column',
        }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--ds-border)' }}>
          {avatar}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>{subtitle}</div>}
          </div>
          {actions}
          <button onClick={onClose} aria-label="Close"
            style={{ color: 'var(--ds-t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{children}</div>

        {footer && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--ds-border)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/** Header/footer button styling, so panels don't each invent their own. */
export const panelBtn = {
  primary: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: 'none', background: 'var(--ds-blue)', color: '#fff', fontSize: 12.5, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
  secondary: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: 'var(--ds-t2)',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
  danger: {
    display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--ds-border)', background: 'var(--ds-surface)', color: '#b91c1c',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
}
