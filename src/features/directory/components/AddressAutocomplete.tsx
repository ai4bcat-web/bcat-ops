import { useState, useCallback, useRef } from 'react'
import { MapPin, Loader2 } from 'lucide-react'
import { TmsButton, TmsInput } from '@/features/tms/kit'
import type { GeocodeResult, AutocompleteSuggestion, Address } from '@/types/tms'
import { autocompleteAddress, getPlaceDetails, geocodeAddress } from '@/lib/apiClient'

function newSessionToken(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random()}` }
}

export function AddressAutocomplete({
  label,
  address,
  onChange,
  error,
}: {
  label?: string
  address?: Partial<Address & { formattedAddress?: string }> | null
  onChange: (result: Partial<GeocodeResult> | null) => void
  error?: string
}) {
  // The visible text is the user's in-progress edit, or the applied address when there
  // is none — derived, so an address applied from outside shows up without an effect.
  const addressText = address ? formatInline(address) : ''
  const [edited, setEdited] = useState<string | null>(null)
  const query = edited ?? addressText
  const setQuery = (next: string) => setEdited(next === addressText ? null : next)
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const tokenRef = useRef(newSessionToken())
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchSuggestions = useCallback(async (text: string) => {
    setFetchError(null)
    if (text.length < 3) { setSuggestions([]); return }
    setLoading(true)
    try {
      const res = await autocompleteAddress(text, tokenRef.current)
      setSuggestions(res)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Address lookup failed')
      setSuggestions([])
    } finally { setLoading(false) }
  }, [])

  const applyPlace = async (placeId: string) => {
    setLoading(true); setFetchError(null)
    try {
      const detail = await getPlaceDetails(placeId, tokenRef.current)
      onChange(detail)
      setEdited(null)
      setSuggestions([])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Could not load place details')
    } finally { setLoading(false) }
  }

  const geocodeCurrent = async () => {
    if (!query.trim()) return
    setGeocoding(true); setFetchError(null)
    try {
      const detail = await geocodeAddress(query)
      onChange(detail)
      setEdited(null)
      setSuggestions([])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Geocode failed')
    } finally { setGeocoding(false) }
  }

  const onBlur = () => {
    blurTimer.current = setTimeout(() => setSuggestions([]), 200)
  }
  const onFocus = () => {
    if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null }
    if (query.trim().length >= 3) void fetchSuggestions(query)
  }

  return (
    <div className="tms-field">
      {label && <span className="tms-field-label">{label}</span>}
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <TmsInput
              value={query}
              onChange={(e) => { setQuery(e.target.value); void fetchSuggestions(e.target.value) }}
              onFocus={onFocus}
              onBlur={onBlur}
              placeholder="Search address (Google Places)"
            />
            {loading && (
              <Loader2
                className="tms-muted"
                size={14}
                style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)' }}
              />
            )}
          </div>
          <TmsButton aria-label="Geocode this address" onClick={geocodeCurrent} disabled={geocoding || !query.trim()}>
            {geocoding ? <Loader2 size={14} /> : <MapPin size={14} />}
          </TmsButton>
        </div>
        {suggestions.length > 0 && (
          <ul
            style={{
              position: 'absolute', zIndex: 50, left: 0, right: 0, marginTop: 4, maxHeight: 192, overflow: 'auto',
              borderRadius: 'var(--tms-radius)', border: '1px solid var(--tms-border)', background: 'var(--tms-card)',
              color: 'var(--tms-text)', listStyle: 'none', padding: 0,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  style={{ width: '100%', padding: '8px 12px', textAlign: 'left', fontSize: 13, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                  onClick={() => void applyPlace(s.placeId)}
                >
                  {s.description}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(error || fetchError) && <span className="tms-field-error">{error || fetchError}</span>}
      {address?.formattedAddress && <span className="tms-field-hint">{address.formattedAddress}</span>}
    </div>
  )
}

function formatInline(a: Partial<Address & { formattedAddress?: string }>): string {
  if (a.formattedAddress) return a.formattedAddress
  return [a.street, a.city, a.state, a.zip, a.country].filter(Boolean).join(', ')
}
