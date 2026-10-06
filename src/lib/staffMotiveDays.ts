/**
 * When each driver's truck was actually moving, for the staff hours page.
 *
 * Calls the driver API with the STAFF token — the same Function URL the driver app uses,
 * on a route that verifies a staff session rather than a driver one. The Motive key lives
 * in that Lambda and never reaches a browser.
 *
 * One request for every driver over the whole pay period. A fortnight of five drivers asked
 * day by day would be seventy round trips to learn the same thing.
 */
import { fetchAuthSession } from 'aws-amplify/auth'
import { DRIVER_API_URL } from '@/features/driver-app/driverApi'
import type { TruckDayWindow } from '@/lib/timeClock'

/** driverId → ISO date → when that truck moved. */
export type MotiveDaysByDriver = Record<string, Record<string, TruckDayWindow>>

export async function fetchMotiveDays(
  driverIds: string[],
  from: string,
  to: string,
): Promise<MotiveDaysByDriver> {
  if (!DRIVER_API_URL || driverIds.length === 0) return {}

  const session = await fetchAuthSession()
  const token = session.tokens?.idToken?.toString()
  if (!token) return {}

  const url =
    `${DRIVER_API_URL.replace(/\/$/, '')}/staff/motive-days` +
    `?driverIds=${encodeURIComponent(driverIds.join(','))}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Motive comparison unavailable (${res.status})`)
  const body = (await res.json()) as { days?: MotiveDaysByDriver }
  return body.days ?? {}
}
