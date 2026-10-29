/**
 * The handful of shapes every settings card repeats, once.
 *
 * Step R re-skins My Brokerage onto the MVMNT kit (`src/features/tms/kit`). Thirteen
 * cards all want the same four things — a titled card with an icon and a sentence of
 * explanation, a checkbox with a label beside it, muted help text and a bordered
 * sub-panel — and thirteen copies of that markup is how a dark theme ends up with one
 * light-grey corner nobody noticed. The kit has no checkbox of its own (Radix's is
 * themed for the BCAT Ops palette), so this is a native one tinted with the TMS accent:
 * it keeps the browser's keyboard and mobile behaviour and needs no portal.
 *
 * Everything here styles with the theme's own tokens; nothing reaches for a `--ds-*`
 * variable or a Tailwind palette class, both of which are light-theme values.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { TmsCard } from '@/features/tms/kit'

const TITLE_ICON: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 }
const PANEL: CSSProperties = {
  border: '1px solid var(--tms-border)',
  borderRadius: 'var(--tms-radius)',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

export function SettingsCard({
  icon: Icon, title, description, actions, children,
}: {
  icon: LucideIcon
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <TmsCard
      title={<span style={TITLE_ICON}><Icon size={14} aria-hidden="true" />{title}</span>}
      actions={actions}
    >
      {description ? <p className="tms-field-hint" style={{ margin: '0 0 12px' }}>{description}</p> : null}
      {children}
    </TmsCard>
  )
}

/** A vertical run of controls. The gap is the one the MVMNT cards use throughout. */
export function Stack({ children, gap = 12, className }: { children: ReactNode; gap?: number; className?: string }) {
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap }}>
      {children}
    </div>
  )
}

/** A checkbox and its sentence. `ariaLabel` names it where the sentence is long. */
export function CheckRow({
  label, checked, onChange, disabled, ariaLabel, align = 'center',
}: {
  label: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  align?: 'center' | 'start'
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: align === 'start' ? 'flex-start' : 'center',
        gap: 10,
        fontSize: 14,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          accentColor: 'var(--tms-primary)',
          width: 15,
          height: 15,
          marginTop: align === 'start' ? 3 : 0,
          flex: '0 0 auto',
        }}
      />
      <span>{label}</span>
    </label>
  )
}

/** Muted explanation under a control. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="tms-field-hint" style={{ margin: 0 }}>{children}</p>
}

/** The refusal a card shows instead of saving — the server's own sentence, verbatim. */
export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="tms-field-error" style={{ margin: 0 }}>{children}</p>
}

/** A labelled group that is not a single field: a checkbox set, a sub-panel, a table. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p
      className="tms-field-label"
      style={{ margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}
    >
      {children}
    </p>
  )
}

/** A bordered sub-panel inside a card: the factor remit-to, a plan, a team. */
export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={style ? { ...PANEL, ...style } : PANEL}>{children}</div>
}

export function Loading() {
  return <p className="tms-muted" style={{ margin: 0, fontSize: 14 }}>Loading…</p>
}
