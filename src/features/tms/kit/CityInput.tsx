import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { InputHTMLAttributes, KeyboardEvent } from 'react'
import { searchCities, type CityOption } from '@/lib/zipLookup'
import { TmsInput } from './TmsInput'

export interface CityInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'role'> {
  value: string
  onChange: (value: string) => void
  /** Narrows the suggestions to one state when the form already has it. */
  state?: string | null
  /** The person picked a place: fill its state and ZIP (useAddressAutofill's pickCity). */
  onPick: (option: CityOption) => void
}

/**
 * A city field that suggests places as you type: "Cochr…" offers "Cochrane, WI 54622". Picking one fills the state and the
 * ZIP (see useAddressAutofill). Offline (the US ZIP table, GeoNames CC BY 4.0), keyboard friendly (arrows, Enter, Escape),
 * and a plain text field if the table is not there: nothing is ever required or overwritten.
 */
export const CityInput = forwardRef<HTMLInputElement, CityInputProps>(function CityInput(
  { value, onChange, state, onPick, className, onBlur, onFocus, onKeyDown, ...rest }, ref,
) {
  const inner = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => inner.current as HTMLInputElement)
  const listId = useId()
  const [options, setOptions] = useState<CityOption[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const typed = useRef(false)

  useEffect(() => {
    if (!typed.current) return
    let live = true
    void searchCities(value, { state }).then((found) => {
      if (!live) return
      setOptions(found)
      setActive(-1)
      setOpen(found.length > 0)
    })
    return () => { live = false }
  }, [value, state])

  const pick = (option: CityOption) => {
    typed.current = false
    setOpen(false)
    setOptions([])
    onPick(option)
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || !open || options.length === 0) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % options.length) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i <= 0 ? options.length - 1 : i - 1)) }
    else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); pick(options[active]) }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
  }

  return (
    <div className="tms-city-input">
      <TmsInput
        {...rest}
        ref={inner}
        className={className}
        value={value}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(event) => { typed.current = true; onChange(event.target.value) }}
        onKeyDown={onKey}
        onFocus={(event) => { onFocus?.(event) }}
        onBlur={(event) => { setOpen(false); onBlur?.(event) }}
      />
      {open && options.length > 0 && (
        <ul className="tms-city-list" id={listId} role="listbox" aria-label="Matching places">
          {options.map((option, i) => (
            <li
              key={`${option.city}|${option.state}|${option.zip}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`tms-city-option${i === active ? ' is-active' : ''}`}
              // mousedown, not click: the input's blur would close the list before a click lands.
              onMouseDown={(event) => { event.preventDefault(); pick(option) }}
            >
              <span>{option.city}, {option.state}</span>
              <span className="tms-city-zip">{option.zip}{option.zipCount > 1 ? ` · ${option.zipCount} ZIPs` : ''}</span>
            </li>
          ))}
          <li className="tms-city-credit" role="presentation">ZIP data: GeoNames, CC BY 4.0</li>
        </ul>
      )}
    </div>
  )
})
