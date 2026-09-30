import { useState, useCallback, useRef } from 'react'
import { MapPin, Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
    <div className="space-y-1.5">
      {label && <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</Label>}
      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); void fetchSuggestions(e.target.value) }}
              onFocus={onFocus}
              onBlur={onBlur}
              placeholder="Search address (Google Places)"
              className="h-9 text-sm"
            />
            {loading && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground animate-spin" />}
          </div>
          <Button type="button" variant="outline" size="sm" className="h-9 px-2" onClick={geocodeCurrent} disabled={geocoding || !query.trim()}>
            {geocoding ? <Loader2 className="size-3.5 animate-spin" /> : <MapPin className="size-3.5" />}
          </Button>
        </div>
        {suggestions.length > 0 && (
          <ul
            className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => void applyPlace(s.placeId)}
                >
                  {s.description}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(error || fetchError) && <p className="text-xs text-destructive">{error || fetchError}</p>}
      {address?.formattedAddress && (
        <p className="text-xs text-muted-foreground">{address.formattedAddress}</p>
      )}
    </div>
  )
}

function formatInline(a: Partial<Address & { formattedAddress?: string }>): string {
  if (a.formattedAddress) return a.formattedAddress
  return [a.street, a.city, a.state, a.zip, a.country].filter(Boolean).join(', ')
}
