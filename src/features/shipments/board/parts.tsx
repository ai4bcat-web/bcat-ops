import type { InputHTMLAttributes, ReactNode } from 'react'

/** A small controlled checkbox styled for the board filter panel. */
export function BoardCheckbox({
  id,
  label,
  checked,
  onChange,
  className,
  ...rest
}: {
  id?: string
  label: ReactNode
  checked?: boolean
  onChange?: (checked: boolean) => void
  className?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'id'>) {
  return (
    <label className={`tms-board-check${className ? ` ${className}` : ''}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="tms-board-check-input"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        {...rest}
      />
      <span className="tms-board-check-label">{label}</span>
    </label>
  )
}

/** A small controlled radio button styled for the board filter panel. */
export function BoardRadio({
  name,
  label,
  value,
  checked,
  onChange,
}: {
  name: string
  label: ReactNode
  value: string
  checked?: boolean
  onChange?: (value: string) => void
}) {
  return (
    <label className="tms-board-check">
      <input
        type="radio"
        className="tms-board-check-input"
        name={name}
        value={value}
        checked={checked}
        aria-label={`${label} ${name.replace('tms-date-', '')}`}
        onChange={() => onChange?.(value)}
      />
      <span className="tms-board-check-label">{label}</span>
    </label>
  )
}

/** Native multi-select for detail filters; the theme keeps it legible on dark surfaces. */
export function BoardMultiSelect({
  id,
  value,
  options,
  placeholder,
  onChange,
}: {
  id?: string
  value: string[]
  options: Array<{ value: string; label: string }>
  placeholder?: string
  onChange?: (values: string[]) => void
}) {
  return (
    <select
      id={id}
      multiple
      className="tms-board-multi"
      value={value}
      onChange={(e) => {
        const selected = Array.from(e.target.selectedOptions).map((o) => o.value)
        onChange?.(selected)
      }}
    >
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** Section header used inside the filter panel. */
export function BoardSectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tms-board-section-head">
      <span className="tms-board-section-title">{children}</span>
      {hint ? <span className="tms-board-section-hint">{hint}</span> : null}
    </div>
  )
}
