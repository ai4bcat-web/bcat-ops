/**
 * The customer search on Payments Received: type a name, pick one, and the page shows only that customer.
 * A picked customer shows as a chip with an × that goes back to everyone. The choice lives in `?customer=` (the page owns that).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { formatCents } from '@/lib/invoiceBuild'
import type { CustomerRecord } from '@/types/tms'
import { searchCustomers } from './customerSuggestions'

export function CustomerSearch({ customers, openByCustomer, selectedId, selectedName, onSelect }: {
  customers: readonly CustomerRecord[]
  openByCustomer: ReadonlyMap<string, number>
  selectedId: string | null
  selectedName?: string
  onSelect: (customerId: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const box = useRef<HTMLDivElement>(null)
  const suggestions = useMemo(() => searchCustomers(query, customers, openByCustomer), [query, customers, openByCustomer])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const pick = (id: string | null) => { onSelect(id); setQuery(''); setOpen(false) }

  if (selectedId) {
    return (
      <span className="pr-cs-chip" data-testid="customer-search-selected">
        <span className="pr-cs-chip-name">{selectedName || 'Customer'}</span>
        <button type="button" className="pr-cs-clear" aria-label="Show all customers" onClick={() => pick(null)}>
          <X size={14} aria-hidden="true" />
        </button>
      </span>
    )
  }

  return (
    <div className="pr-cs" ref={box} data-testid="customer-search">
      <Search size={14} aria-hidden="true" className="pr-cs-icon" />
      <input
        type="search"
        role="combobox"
        className="pr-cs-input"
        aria-label="Search customers"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder="Find a customer…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, suggestions.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter' && open && suggestions[active]) { e.preventDefault(); pick(suggestions[active].customer.id) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="pr-cs-list" aria-label="Customers">
          {suggestions.length === 0 && <li className="pr-cs-empty tms-muted">{query.trim() ? 'No customer matches.' : 'Type a customer name.'}</li>}
          {suggestions.map((s, i) => (
            <li key={s.customer.id} role="option" aria-selected={i === active}>
              <button type="button" className={`pr-cs-opt${i === active ? ' pr-cs-opt-on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => pick(s.customer.id)}>
                <span>{s.customer.name}</span>
                {s.openCents > 0 && <span className="tms-muted pr-cs-open">{formatCents(s.openCents)} open</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
