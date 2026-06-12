import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * Section header — an icon chip + title + optional subtitle, with its fields indented
 * underneath. Pass `collapsible` (default-collapsed via `defaultOpen={false}`) to make
 * the section toggle open/closed so forms can open short instead of as a long scroll.
 */
export function FormSection({
  icon, title, subtitle, right, children,
  collapsible = false, defaultOpen = true,
}: {
  icon?: ReactNode
  title: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const isOpen = collapsible ? open : true

  const Header = (
    <>
      {icon && (
        <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ds-blue)', flexShrink: 0 }}>
          {icon}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: 'var(--ds-t3)', marginTop: 1 }}>{subtitle}</div>}
      </div>
      {right}
      {collapsible && (
        <ChevronDown size={16} style={{ color: 'var(--ds-t3)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
      )}
    </>
  )

  return (
    <section>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {Header}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{Header}</div>
      )}

      {isOpen && (
        <div style={{ marginTop: 14, paddingLeft: icon ? 40 : 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * Field wrapper — label sits above the input (5px gap), uppercase 11px, with an
 * optional right-aligned hint. The input/control is passed as children.
 */
export function Field({
  label, hint, htmlFor, children,
}: {
  label?: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      {(label || hint) && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          {label && (
            <label htmlFor={htmlFor} style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ds-t3)' }}>
              {label}
            </label>
          )}
          {hint && <span style={{ fontSize: 11, color: 'var(--ds-t3)' }}>{hint}</span>}
        </div>
      )}
      {children}
    </div>
  )
}
