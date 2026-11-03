import type { KeyboardEvent } from 'react'

export type TmsPeriod = 'D' | 'W' | 'M'

export interface TmsPeriodToggleProps {
  value: TmsPeriod
  onChange: (next: TmsPeriod) => void
  /** Default `['D','W','M']`. */
  options?: readonly TmsPeriod[]
  'aria-label'?: string
}

const DEFAULT_OPTIONS: readonly TmsPeriod[] = ['D', 'W', 'M']

/** The D / W / M chips on a stat card. Left/Right move the selection. */
export function TmsPeriodToggle({ value, onChange, options = DEFAULT_OPTIONS, 'aria-label': ariaLabel = 'Period' }: TmsPeriodToggleProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const at = Math.max(0, options.indexOf(value))
    const next = options[(at + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]
    onChange(next)
    const group = e.currentTarget.parentElement
    const idx = options.indexOf(next)
    requestAnimationFrame(() => (group?.children[idx] as HTMLElement | undefined)?.focus())
  }
  return (
    <div role="group" aria-label={ariaLabel} className="tms-period-toggle">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          className="tms-period-chip"
          onClick={() => onChange(option)}
          onKeyDown={onKeyDown}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

export default TmsPeriodToggle
