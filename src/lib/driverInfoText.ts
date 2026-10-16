/**
 * The block dispatch pastes to a broker or shipper for one driver: who, what they are in,
 * how to reach them, where to watch them. One line per fact, nothing missing is invented.
 */
export function driverInfoText(info: {
  name: string
  phone?: string | null
  truck?: string | null
  vin?: string | null
  trailer?: string | null
  trackingUrl?: string | null
}): string {
  const lines = [
    `Driver: ${info.name}`,
    info.phone ? `Cell: ${info.phone}` : null,
    info.truck ? `Truck: ${info.truck}` : null,
    info.vin ? `VIN: ${info.vin}` : null,
    info.trailer ? `Trailer: ${info.trailer}` : null,
    info.trackingUrl ? `Tracking: ${info.trackingUrl}` : null,
  ]
  return lines.filter((l): l is string => !!l).join('\n')
}
