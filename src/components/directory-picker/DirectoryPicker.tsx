import { useState, useMemo, useRef, useEffect } from 'react'
import { Search, Plus, MapPin, Building2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { CustomerRecord, LocationRecord } from '@/types/tms'
import { findCustomerMatches, findLocationMatches, locationAddress } from '@/lib/tmsDirectory'

export interface DirectoryPickerProps {
  type: 'customer' | 'location'
  value?: string | null
  placeholder?: string
  customers: CustomerRecord[]
  locations: LocationRecord[]
  initialQuery?: string
  onChange: (id: string | null, record?: CustomerRecord | LocationRecord | null) => void
  onCreateNew?: (initial: { name?: string; city?: string }) => void
}

export function DirectoryPicker({
  type,
  value,
  placeholder,
  customers,
  locations,
  initialQuery = '',
  onChange,
  onCreateNew,
}: DirectoryPickerProps) {
  const [query, setQuery] = useState(initialQuery)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const selected = useMemo(() => {
    if (!value) return null
    if (type === 'customer') return customers.find((c) => c.id === value) ?? null
    return locations.find((l) => l.id === value) ?? null
  }, [type, value, customers, locations])

  const matches = useMemo(() => {
    if (!query.trim()) return []
    if (type === 'customer') return findCustomerMatches(query, customers)
    return findLocationMatches({ name: query }, locations)
  }, [query, customers, locations, type])

  const activeMatches = matches.filter((m) => m.record.active !== false)

  const selectedLabel = selected ? (type === 'customer' ? (selected as CustomerRecord).name : labelLocation(selected as LocationRecord)) : placeholder ?? `Choose ${type}…`

  return (
    <div ref={ref} className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            placeholder={selectedLabel}
            className="h-9 pl-8 text-sm"
          />
        </div>
        {onCreateNew && type === 'customer' && (
          <Button type="button" variant="outline" size="sm" className="h-9 px-2" onClick={() => onCreateNew({ name: query })}>
            <Plus className="size-3.5" />
          </Button>
        )}
        {onCreateNew && type === 'location' && (
          <Button type="button" variant="outline" size="sm" className="h-9 px-2" onClick={() => onCreateNew({ name: query })}>
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md">
          {query.trim().length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Type to search the directory</div>
          ) : activeMatches.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matches. Use + to create.</div>
          ) : (
            <ul>
              {activeMatches.map((m) => {
                const record = m.record
                const isCustomer = type === 'customer'
                const title = isCustomer ? (record as CustomerRecord).name : (record as LocationRecord).name
                const sub = isCustomer
                  ? [(record as CustomerRecord).aliases?.[0], (record as CustomerRecord).mcNumber].filter(Boolean).join(' · ')
                  : formatInlineAddress(locationAddress(record as LocationRecord))
                return (
                  <li key={record.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
                      onClick={() => { onChange(record.id, record); setQuery(title); setOpen(false) }}
                    >
                      <div className="flex items-center gap-2 text-sm">
                        {isCustomer ? <Building2 className="size-3.5 text-muted-foreground" /> : <MapPin className="size-3.5 text-muted-foreground" />}
                        <span className="font-medium">{title}</span>
                        {sub && <span className="text-muted-foreground truncate">· {sub}</span>}
                      </div>
                      <div className="pl-[18px] text-xs text-muted-foreground mt-0.5">
                        {Math.round(m.score * 100)}% — {m.reason}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function labelLocation(l: LocationRecord): string {
  const city = [l.city, l.state].filter(Boolean).join(', ') || l.zip || ''
  return city ? `${l.name} — ${city}` : l.name
}

function formatInlineAddress(a: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null }) {
  return [a.street, [a.city, a.state].filter(Boolean).join(', '), a.zip, a.country].filter(Boolean).join(' · ')
}
