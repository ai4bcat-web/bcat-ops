import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ChargeCodeOption {
  code: string
  label?: string
}

export interface ChargeCodeInputProps {
  value: string
  /** Called with the upper-cased code, whether it was typed or picked. */
  onChange: (code: string) => void
  options: readonly ChargeCodeOption[]
  disabled?: boolean
  placeholder?: string
  className?: string
  'aria-label'?: string
  'data-testid'?: string
}

const PANEL_MAX_HEIGHT = 240
const GAP = 4
const EDGE = 8

interface Place { top: number; left: number; width: number; maxHeight: number }

/** A code field with a compact, filterable list in place of the browser's own datalist popup. */
export function ChargeCodeInput({
  value, onChange, options, disabled, placeholder = 'Pick or type a code', className, 'aria-label': ariaLabel, 'data-testid': testId,
}: ChargeCodeInputProps) {
  const [open, setOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<Place | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  const q = value.trim().toUpperCase()
  const shown = useMemo(() => {
    if (filtering === false || q === '') return options
    return options.filter((o) => o.code.toUpperCase().includes(q) || (o.label ?? '').toUpperCase().includes(q))
  }, [options, q, filtering])

  const pick = (code: string) => {
    onChange(code.toUpperCase())
    setFiltering(false)
    setOpen(false)
  }

  useLayoutEffect(() => {
    if (open === false) return
    const measure = () => {
      const el = inputRef.current
      if (el == null) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - EDGE - GAP
      const above = r.top - EDGE - GAP
      const wantsHeight = Math.min(PANEL_MAX_HEIGHT, shown.length * 32 + 8)
      const flip = below < wantsHeight && above > below
      const maxHeight = Math.max(96, Math.min(PANEL_MAX_HEIGHT, flip ? above : below))
      const width = Math.max(r.width, 240)
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE))
      const height = Math.min(maxHeight, wantsHeight)
      setPlace({ top: flip ? r.top - GAP - height : r.bottom + GAP, left, width, maxHeight })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, shown.length])

  useEffect(() => {
    if (open === false) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (inputRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
      setFiltering(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (open === false) return
    panelRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  const activeId = open && shown[active] ? `${listId}-${active}` : undefined

  return (
    <>
      <input
        ref={inputRef}
        className={`tms-input${className ? ` ${className}` : ''}`}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        data-testid={testId}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onFocus={() => { setActive(0); setOpen(true) }}
        onChange={(e) => {
          onChange(e.target.value.toUpperCase())
          setFiltering(true)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (open === false) { setOpen(true); return }
            setActive((i) => Math.min(shown.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter' && open && shown[active]) {
            e.preventDefault()
            pick(shown[active].code)
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            setFiltering(false)
          } else if (e.key === 'Tab') {
            setOpen(false)
            setFiltering(false)
          }
        }}
      />
      {open && place && shown.length > 0 && createPortal(
        <ul
          ref={panelRef}
          id={listId}
          role="listbox"
          className="tms-portal tms-code-list"
          style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}
        >
          {shown.map((o, i) => (
            <li
              key={o.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`tms-code-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(o.code) }}
            >
              <span className="tms-code-name">{o.code}</span>
              {o.label && o.label.toUpperCase() !== o.code.toUpperCase() && <span className="tms-code-desc">{o.label}</span>}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  )
}
