import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { conversationTitle, type DispatchConversation } from '@/lib/dispatch'
import { FLEET_SECTION_LABEL, SECTION_ORDER, type FleetSectionKey } from './fleetSections'
import type { DispatchFilters } from './dispatchFilters'

interface Props {
  value: DispatchFilters
  conversations: readonly DispatchConversation[]
  onClose: () => void
  onApply: (next: DispatchFilters) => void
}

/** Which driver types and which drivers this person wants in their list. */
export function FilterDialog({ value, conversations, onClose, onApply }: Props) {
  const [types, setTypes] = useState<FleetSectionKey[]>(value.types)
  const [hidden, setHidden] = useState<Set<string>>(new Set(value.hiddenNames.map((n) => n.toLowerCase())))
  const [query, setQuery] = useState('')
  const names = useMemo(() => Array.from(new Set(conversations.map((c) => conversationTitle(c)))).sort((a, b) => a.localeCompare(b)), [conversations])
  const shown = names.filter((n) => !query.trim() || n.toLowerCase().includes(query.trim().toLowerCase()))
  const toggleType = (k: FleetSectionKey) => setTypes((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]))
  const toggleName = (n: string) => setHidden((h) => { const next = new Set(h); const key = n.toLowerCase(); if (next.has(key)) next.delete(key); else next.add(key); return next })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Filter conversations</DialogTitle>
          <DialogDescription>Only you see this filter; it is remembered on this device.</DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 14 }}>
          <section style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ds-t3)' }}>Driver type</span>
              <button type="button" onClick={() => setTypes(types.length === SECTION_ORDER.length ? [] : [...SECTION_ORDER])} style={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: 'var(--ds-blue)' }}>{types.length === SECTION_ORDER.length ? 'None' : 'All'}</button>
            </div>
            {SECTION_ORDER.map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" id={`dispatch-filter-type-${k}`} checked={types.includes(k)} onChange={() => toggleType(k)} /> {FLEET_SECTION_LABEL[k]}
              </label>
            ))}
          </section>
          <section style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ds-t3)' }}>Drivers</span>
              <button type="button" onClick={() => setHidden(hidden.size ? new Set() : new Set(names.map((n) => n.toLowerCase())))} style={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: 'var(--ds-blue)' }}>{hidden.size ? 'All' : 'None'}</button>
            </div>
            <Input id="dispatch-filter-search" placeholder="Find a driver" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8" />
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--ds-border)', borderRadius: 8, padding: '4px 8px' }}>
              {shown.length === 0 ? <div style={{ fontSize: 12, color: 'var(--ds-t3)', padding: 6 }}>No drivers match.</div> : shown.map((n) => (
                <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, padding: '4px 0' }}>
                  <input type="checkbox" checked={!hidden.has(n.toLowerCase())} onChange={() => toggleName(n)} /> {n}
                </label>
              ))}
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setTypes([...SECTION_ORDER]); setHidden(new Set()) }}>Show all</Button>
          <Button onClick={() => { onApply({ types, hiddenNames: names.filter((n) => hidden.has(n.toLowerCase())) }); onClose() }}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
