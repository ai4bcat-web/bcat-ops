import type { ReactNode } from 'react'
import { fmtUSD, fmtCents } from '@/lib/ui/table-formatters'
import { cn } from '@/lib/utils'

/**
 * Shared table-cell building blocks for the redesigned data tables (STEP 4).
 * Every table page reuses these so identity cells, chips and money cells stay
 * consistent: colored tile + semibold primary + muted subtitle, pills for sparse
 * columns, right-aligned mono money with "—" for empty.
 */

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
  const c = color ?? 'var(--tms-primary)'
  const style = tone === 'soft'
    ? { background: `color-mix(in srgb, ${c} 14%, var(--tms-card))`, color: c }
    : { background: c, color: 'var(--tms-on-primary)' }
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
  ok:      'bg-[color:var(--tms-badge-green-tint)] text-[color:var(--tms-badge-green)]',
  warn:    'bg-[color:var(--tms-badge-orange-tint)] text-[color:var(--tms-badge-orange)]',
  bad:     'bg-[color:var(--tms-badge-red-tint)] text-[color:var(--tms-badge-red)]',
  blue:    'bg-[color:var(--tms-badge-blue-tint)] text-[color:var(--tms-badge-blue)]',
  violet:  'bg-[color:var(--tms-badge-purple-tint)] text-[color:var(--tms-badge-purple)]',
  neutral: 'bg-muted text-muted-foreground',
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
