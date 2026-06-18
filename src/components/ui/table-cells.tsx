import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared table-cell building blocks for the redesigned data tables (STEP 4).
 * Every table page reuses these so identity cells, chips and money cells stay
 * consistent: colored tile + semibold primary + muted subtitle, pills for sparse
 * columns, right-aligned mono money with "—" for empty.
 */

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Money from dollars → "$1,234" (or "—" when null/0-and-dashable). */
export function fmtUSD(dollars: number | null | undefined, opts?: { cents?: boolean; dashZero?: boolean }): string {
  if (dollars == null) return '—'
  if (opts?.dashZero && dollars === 0) return '—'
  return usd0.format(dollars)
}
/** Money from integer cents → "$1,234.56" (or "—"). */
export function fmtCents(cents: number | null | undefined, dashZero = false): string {
  if (cents == null) return '—'
  if (dashZero && cents === 0) return '—'
  return usd2.format(cents / 100)
}

/** Right-aligned mono money cell content; empty → muted "—". */
export function MoneyCell({ value, cents, className }: { value: number | null | undefined; cents?: boolean; className?: string }) {
  const text = cents ? fmtCents(value, true) : fmtUSD(value, { dashZero: true })
  const empty = text === '—'
  return (
    <span className={cn('font-mono tabular-nums', empty && 'text-muted-foreground/50', className)}>{text}</span>
  )
}

/** Colored rounded tile holding an icon or initials — the leading visual of an identity cell. */
export function CellTile({ color, tone = 'solid', children, className }: { color?: string; tone?: 'solid' | 'soft'; children: ReactNode; className?: string }) {
  const c = color ?? 'var(--ds-blue)'
  const style = tone === 'soft'
    ? { background: `color-mix(in srgb, ${c} 14%, white)`, color: c }
    : { background: c, color: '#fff' }
  return (
    <span className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-lg', className)} style={style} aria-hidden>
      {children}
    </span>
  )
}

/** First-column identity cell: tile + semibold primary line + muted subtitle, all truncating. */
export function IdentityCell({ tile, primary, subtitle }: { tile?: ReactNode; primary: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {tile}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-tight text-foreground">{primary}</div>
        {subtitle != null && subtitle !== '' && (
          <div className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">{subtitle}</div>
        )}
      </div>
    </div>
  )
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'blue' | 'violet' | 'neutral'

const CHIP_TONES: Record<ChipTone, string> = {
  ok:      'bg-[var(--ds-green-bg)] text-[var(--ds-green)]',
  warn:    'bg-[var(--ds-amber-bg)] text-[var(--ds-amber)]',
  bad:     'bg-[var(--ds-red-bg)] text-[var(--ds-red)]',
  blue:    'bg-[var(--ds-blue-bg)] text-[var(--ds-blue-dark)]',
  violet:  'bg-[var(--ds-violet-bg)] text-[var(--ds-violet)]',
  neutral: 'bg-slate-100 text-slate-600',
}

/** Small status pill with optional leading dot. */
export function Chip({ tone = 'neutral', dot, children, className }: { tone?: ChipTone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', CHIP_TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full" style={{ background: 'currentColor' }} />}
      {children}
    </span>
  )
}
