/**
 * The owner-operator app sends paperwork to a load the driver picks, never to a typed
 * number. These name and find that load.
 */
import type { RecentLoad } from '../driverApi'

const normPro = (pro: string) => pro.trim().toUpperCase().replace(/^0+/, '')

/** The driver's load with this PRO, if it is one of theirs. */
export function findLoadByPro(loads: readonly RecentLoad[], pro: string): RecentLoad | undefined {
  const want = normPro(pro)
  return want ? loads.find((l) => normPro(l.proNumber) === want) : undefined
}

/** "PRO 20031 · El Paso, TX → Edwardsville, IL": how the app names the load a document goes to. */
export function loadLabel(pro: string, lane: string | null | undefined): string {
  return [pro ? `PRO ${pro}` : null, lane || null].filter(Boolean).join(' · ')
}
