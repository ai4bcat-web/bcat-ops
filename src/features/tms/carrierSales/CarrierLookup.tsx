/**
 * Step AS — Carrier Sales' MC lookup: type an MC or DOT, see at once whether the carrier is set up with us
 * (and active), where its MyCarrierPackets packet stands, and what MCP says about it; then send the setup
 * packet, add it to the directory or cover a load with it. A typed NAME lists the carriers we already have set up (MCP has no name
 * search), each with whether it is active and why; picking one looks it up by its MC / DOT.
 */
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { CoverCarrierDialog } from '@/features/carriers/cover/CoverCarrierDialog'
import { directoryStanding } from '@/features/carriers/cover/coverModel'
import { useCarriers } from '@/hooks/useCarriers'
import { TmsBadge, TmsButton, TmsCard, TmsInput, TmsSelect } from '@/features/tms/kit'
import type { ShipmentListRow } from '@/hooks/useShipments'
import { parseSearch, searchDirectory } from '@/lib/integrations/mcpReview'
import { CarrierLookupPanel } from './CarrierLookupPanel'
import type { LookupRef } from './CarrierLookupPanel'

/** Our own carriers matching a typed name, each with whether it is active and why. Only mounted for a name (it reads the directory). */
function NameMatches({ typed, onPick }: { typed: string; onPick: (ref: LookupRef) => void }) {
  const q = typed.trim()
  if (q.length < 2 || parseSearch(q).kind !== 'NAME') return null
  return <NameMatchList q={q} onPick={onPick} />
}

function NameMatchList({ q, onPick }: { q: string; onPick: (ref: LookupRef) => void }) {
  const { carriers } = useCarriers()
  const matches = useMemo(() => searchDirectory(carriers, q), [carriers, q])
  if (matches.length === 0) return <p className="tms-muted" style={{ fontSize: 12, margin: 0 }} data-testid="cs-name-none">None of our carriers match that name. Enter an MC or DOT number to look one up.</p>
  return (
    <ul className="flex flex-col gap-1" style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="cs-name-matches" aria-label="Carriers in our directory">
      {matches.map((c) => {
        const st = directoryStanding(c)
        return (
          <li key={c.id}>
            <button type="button" className="tms-empty-action flex w-full flex-wrap items-center gap-2" data-testid={`cs-name-match-${c.id}`}
              onClick={() => onPick({ ...(c.mcNumber ? { mcNumber: c.mcNumber.replace(/^MC/i, '') } : {}), ...(c.dotNumber ? { dotNumber: c.dotNumber } : {}) })}>
              <strong>{c.name}</strong>
              <span className="tms-muted" style={{ fontSize: 12 }}>{[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`].filter(Boolean).join(' · ')}</span>
              <TmsBadge tone={st.active ? 'green' : c.status === 'DO_NOT_USE' ? 'red' : 'orange'}>{st.label}</TmsBadge>
              {st.why ? <span className="tms-muted" style={{ fontSize: 12 }}>{st.why}</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function CarrierLookup({ needsCover, nowIso, onCovered }: { needsCover: readonly ShipmentListRow[]; nowIso?: string; onCovered?: () => void }) {
  const [typed, setTyped] = useState('')
  const [lookup, setLookup] = useState<LookupRef | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [coverId, setCoverId] = useState('')
  const [cover, setCover] = useState<{ row: ShipmentListRow; query: string } | null>(null)

  const submit = () => {
    const parsed = parseSearch(typed)
    if (parsed.kind === 'MC' || parsed.kind === 'DOT') {
      setHint(null)
      setLookup({ ...(parsed.mcNumber ? { mcNumber: parsed.mcNumber } : {}), ...(parsed.dotNumber ? { dotNumber: parsed.dotNumber } : {}) })
    } else {
      setLookup(null)
      setHint(parsed.kind === 'NAME' ? 'Pick one of our carriers from the list, or enter an MC or DOT number: MyCarrierPackets looks carriers up by number.' : null)
    }
  }

  const target = needsCover.find((r) => r.id === coverId) ?? needsCover[0] ?? null

  return (
    <TmsCard title="Carrier lookup">
      <div style={{ display: 'grid', gap: 8 }} data-testid="cs-carrier-lookup">
        <form style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} role="search" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <TmsInput aria-label="Carrier name, MC or DOT" data-testid="cs-lookup-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Carrier name, MC 274623 or DOT 1234567" style={{ minWidth: 260 }} />
          <TmsButton type="submit" size="sm" variant="primary" disabled={!typed.trim()} data-testid="cs-lookup-go"><Search size={13} /> Look up</TmsButton>
          {needsCover.length > 0 && lookup ? (
            <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
              <span className="tms-muted">Cover load</span>
              <TmsSelect aria-label="Load to cover" value={target?.id ?? ''} onChange={(e) => setCoverId(e.target.value)}>
                {needsCover.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
              </TmsSelect>
            </label>
          ) : null}
        </form>
        <NameMatches typed={typed} onPick={(ref) => { setHint(null); setLookup(ref) }} />
        {hint ? <p className="tms-muted" style={{ fontSize: 12, margin: 0 }}>{hint}</p> : null}
        {lookup ? (
          <CarrierLookupPanel
            key={`${lookup.mcNumber ?? ''}|${lookup.dotNumber ?? ''}`}
            lookup={lookup}
            nowIso={nowIso}
            onCover={target ? () => setCover({ row: target, query: lookup.mcNumber ? `MC ${lookup.mcNumber.replace(/^MC/i, '')}` : `DOT ${lookup.dotNumber ?? ''}` }) : undefined}
          />
        ) : null}
      </div>
      {cover ? (
        <CoverCarrierDialog shipmentId={cover.row.id} shipmentNumber={cover.row.number} initialQuery={cover.query} onClose={() => setCover(null)} onCovered={() => { onCovered?.() }} />
      ) : null}
    </TmsCard>
  )
}
