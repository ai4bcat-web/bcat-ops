/**
 * Google encoded polyline, precision 5 — the route the server caches is stored this way
 * and drawn by both the Google and the SVG renderer, so the browser needs no Maps
 * `geometry` library. Pure; bundled by the Lambdas through a relative import.
 */
export interface LatLng { lat: number; lng: number }

const EARTH_RADIUS_MILES = 3958.7613

export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = []
  let index = 0
  let lat = 0
  let lng = 0
  const next = (): number | null => {
    let result = 0
    let shift = 0
    let byte: number
    do {
      if (index >= encoded.length) return null
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (index < encoded.length) {
    const dLat = next()
    const dLng = next()
    if (dLat === null || dLng === null) break
    lat += dLat
    lng += dLng
    out.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return out
}

function encodeValue(value: number, into: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1
  while (v >= 0x20) {
    into.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63))
    v >>= 5
  }
  into.push(String.fromCharCode(v + 63))
}

export function encodePolyline(path: LatLng[]): string {
  const out: string[] = []
  let prevLat = 0
  let prevLng = 0
  for (const p of path) {
    const lat = Math.round(p.lat * 1e5)
    const lng = Math.round(p.lng * 1e5)
    encodeValue(lat - prevLat, out)
    encodeValue(lng - prevLng, out)
    prevLat = lat
    prevLng = lng
  }
  return out.join('')
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}
