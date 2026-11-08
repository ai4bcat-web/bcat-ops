import { forwardRef } from 'react'
import type { SelectHTMLAttributes } from 'react'

export interface TmsSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface TmsSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Convenience for the common case; ignored when children are supplied. */
  options?: TmsSelectOption[]
  placeholder?: string
}

/**
 * A native select styled by the theme — no Radix portal, so it needs no `.tms-portal`
 * and keeps keyboard and mobile behaviour the browser already gets right.
 */
export const TmsSelect = forwardRef<HTMLSelectElement, TmsSelectProps>(
  ({ className, options, placeholder, children, ...rest }, ref) => (
    <select ref={ref} className={`tms-select${className ? ` ${className}` : ''}`} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {children ??
        options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
    </select>
  )
)
TmsSelect.displayName = 'TmsSelect'
