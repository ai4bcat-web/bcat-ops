interface LatLng { lat: number; lng: number }

/**
 * The rest of the Maps bundle this pane leans on. Declared here rather than on
 * `Window.google` because that global is shared with the board map, and two
 * declarations of the same property must match exactly — widening it would
 * break the other reader for no one's benefit.
 */
export interface GoogleMapsExtras {
  LatLngBounds?: new () => { extend(p: LatLng): void }
  DistanceMatrixService?: new () => {
    getDistanceMatrix(
      request: {
        origins: LatLng[]
        destinations: LatLng[]
        travelMode: string
      },
      callback: (
        response: {
          rows: Array<{
            elements: Array<{
              status: string
              distance?: { value: number }
              duration?: { value: number }
            }>
          }>
        } | null,
        status: string,
      ) => void,
    ): void
  }
}

/** The extra Maps APIs, when the bundle the map already loaded exposes them. */
export function googleMapsExtras(): GoogleMapsExtras | undefined {
  return window.google?.maps as unknown as GoogleMapsExtras | undefined
}
