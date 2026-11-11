/**
 * The progress-step catalog and its per-division configuration (Ryne 2026-11-11: "make this self serve in settings so we can define what
 * the progress steps are for each type of rev division").
 *
 * A step is chosen from a fixed CATALOG (a step is something the system can actually tell: a carrier-workflow fact, a driver-app status
 * update, a Motive location milestone). What Settings stores (`TmsSettings.progressSteps`) is only the ORDER, the LABEL and an on/off flag
 * per step, per revenue division and per variant. Nothing saved means the built-in defaults below, so behaviour is unchanged until
 * somebody edits. Pure. Relative imports only (the directory Lambda validates a save with `validateProgressSteps`).
 */

export type StepVariant = 'CARRIER' | 'LOCAL_DRIVER' | 'OWNER_OPERATOR'
export const STEP_VARIANTS: readonly StepVariant[] = ['CARRIER', 'LOCAL_DRIVER', 'OWNER_OPERATOR']
export const VARIANT_LABEL: Record<StepVariant, string> = {
  CARRIER: 'Outside carrier',
  LOCAL_DRIVER: 'Local driver (driver app)',
  OWNER_OPERATOR: 'Owner operator (Motive)',
}

/** Where the evidence for a step comes from. STOP_CLOCK is the stop's actual arrived/departed time: the driver app for a local driver, Motive for an owner operator. */
export type StepSource = 'WORKFLOW' | 'DRIVER_APP' | 'MOTIVE' | 'STOP_CLOCK'

export type StepKey =
  | 'created' | 'covered' | 'setup' | 'rateConSent' | 'rateConSigned' | 'driverInfo'
  | 'dispatched' | 'delivered' | 'loadReview' | 'billed' | 'paid'
  | 'assetAssigned' | 'assetStarted' | 'assetLocated' | 'assetArrivedPickup' | 'assetLeftPickup' | 'assetArrivedDelivery'

export interface CatalogStep { key: StepKey; label: string; source: StepSource; variants: readonly StepVariant[] }

const ALL = STEP_VARIANTS
const CARRIER_ONLY: readonly StepVariant[] = ['CARRIER']
const DRIVERS: readonly StepVariant[] = ['LOCAL_DRIVER', 'OWNER_OPERATOR']

export const STEP_CATALOG: readonly CatalogStep[] = [
  { key: 'created', label: 'Created', source: 'WORKFLOW', variants: ALL },
  { key: 'covered', label: 'Covered', source: 'WORKFLOW', variants: CARRIER_ONLY },
  { key: 'setup', label: 'Carrier set up', source: 'WORKFLOW', variants: CARRIER_ONLY },
  { key: 'rateConSent', label: 'Rate confirmation sent', source: 'WORKFLOW', variants: CARRIER_ONLY },
  { key: 'rateConSigned', label: 'Rate confirmation signed', source: 'WORKFLOW', variants: CARRIER_ONLY },
  { key: 'driverInfo', label: 'Driver and truck info in', source: 'WORKFLOW', variants: CARRIER_ONLY },
  { key: 'dispatched', label: 'Dispatched', source: 'WORKFLOW', variants: CARRIER_ONLY },
  { key: 'assetAssigned', label: 'Driver assigned', source: 'WORKFLOW', variants: DRIVERS },
  { key: 'assetStarted', label: 'Dispatched to the driver', source: 'DRIVER_APP', variants: ['LOCAL_DRIVER'] },
  { key: 'assetLocated', label: 'Truck located by Motive', source: 'MOTIVE', variants: ['OWNER_OPERATOR'] },
  { key: 'assetArrivedPickup', label: 'Arrived at pickup', source: 'STOP_CLOCK', variants: DRIVERS },
  { key: 'assetLeftPickup', label: 'Loaded, left pickup', source: 'STOP_CLOCK', variants: DRIVERS },
  { key: 'assetArrivedDelivery', label: 'Arrived at delivery', source: 'STOP_CLOCK', variants: DRIVERS },
  { key: 'delivered', label: 'Delivered', source: 'WORKFLOW', variants: ALL },
  { key: 'loadReview', label: 'Sent to Load Review', source: 'WORKFLOW', variants: ALL },
  { key: 'billed', label: 'Billed', source: 'WORKFLOW', variants: ALL },
  { key: 'paid', label: 'Paid', source: 'WORKFLOW', variants: ALL },
]

const CATALOG_BY_KEY = new Map<string, CatalogStep>(STEP_CATALOG.map((c) => [c.key, c]))
export const catalogStep = (key: string): CatalogStep | undefined => CATALOG_BY_KEY.get(key)
export const catalogFor = (variant: StepVariant): CatalogStep[] => STEP_CATALOG.filter((c) => c.variants.includes(variant))

const TAIL: StepKey[] = ['delivered', 'loadReview', 'billed', 'paid']
export const DEFAULT_STEP_KEYS: Record<StepVariant, readonly StepKey[]> = {
  CARRIER: ['created', 'covered', 'setup', 'rateConSent', 'rateConSigned', 'driverInfo', 'dispatched', ...TAIL],
  LOCAL_DRIVER: ['created', 'assetAssigned', 'assetStarted', 'assetArrivedPickup', 'assetLeftPickup', 'assetArrivedDelivery', ...TAIL],
  OWNER_OPERATOR: ['created', 'assetAssigned', 'assetLocated', 'assetArrivedPickup', 'assetLeftPickup', 'assetArrivedDelivery', ...TAIL],
}

export interface StepSetting { key: string; label: string; enabled: boolean }
export type ProgressStepsConfig = Record<string, Partial<Record<StepVariant, StepSetting[]>>>

/** The built-in list for a variant: its default steps in order, enabled, with the catalog labels. */
export function defaultSettings(variant: StepVariant): StepSetting[] {
  return DEFAULT_STEP_KEYS[variant].map((key) => ({ key, label: catalogStep(key)!.label, enabled: true }))
}

/** Every catalog step the variant could show but the saved list left out, so the editor can offer it (disabled, at the end). */
export function withMissingSteps(list: readonly StepSetting[], variant: StepVariant): StepSetting[] {
  const have = new Set(list.map((s) => s.key))
  return [...list, ...catalogFor(variant).filter((c) => !have.has(c.key)).map((c) => ({ key: c.key, label: c.label, enabled: false }))]
}

const MAX_LABEL = 60
const DIVISION_CODE = /^[A-Za-z0-9_-]{1,40}$/

/** One variant's list, checked. Throws a one-sentence reason a person can act on. */
export function validateStepList(raw: unknown, where: string, variant: StepVariant): StepSetting[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: steps must be a list`)
  if (raw.length === 0 || raw.length > STEP_CATALOG.length) throw new Error(`${where}: needs between 1 and ${STEP_CATALOG.length} steps`)
  const seen = new Set<string>()
  const out: StepSetting[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where}: each step needs a key, a label and an on/off flag`)
    const { key, label, enabled } = item as Record<string, unknown>
    if (typeof key !== 'string' || !catalogStep(key)) throw new Error(`${where}: "${String(key)}" is not a known step`)
    if (!catalogStep(key)!.variants.includes(variant)) throw new Error(`${where}: "${catalogStep(key)!.label}" does not apply to ${VARIANT_LABEL[variant]}`)
    if (seen.has(key)) throw new Error(`${where}: "${catalogStep(key)!.label}" is listed twice`)
    seen.add(key)
    if (typeof enabled !== 'boolean') throw new Error(`${where}: "${catalogStep(key)!.label}" needs an on/off flag`)
    const text = typeof label === 'string' ? label.trim() : ''
    if (text.length > MAX_LABEL) throw new Error(`${where}: "${catalogStep(key)!.label}" label is over ${MAX_LABEL} characters`)
    out.push({ key, label: text || catalogStep(key)!.label, enabled })
  }
  if (!out.some((s) => s.enabled)) throw new Error(`${where}: at least one step has to be on`)
  return out
}

/** The whole saved setting, checked. `null` / empty clears it (every division back to the defaults). */
export function validateProgressSteps(raw: unknown): ProgressStepsConfig | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('progressSteps must be an object keyed by revenue division')
  const out: ProgressStepsConfig = {}
  for (const [division, variants] of Object.entries(raw as Record<string, unknown>)) {
    if (!DIVISION_CODE.test(division)) throw new Error(`"${division}" is not a revenue division code`)
    if (!variants || typeof variants !== 'object' || Array.isArray(variants)) throw new Error(`${division}: expected one list per variant`)
    const entry: Partial<Record<StepVariant, StepSetting[]>> = {}
    for (const [variant, list] of Object.entries(variants as Record<string, unknown>)) {
      if (!(STEP_VARIANTS as readonly string[]).includes(variant)) throw new Error(`${division}: "${variant}" is not a variant`)
      entry[variant as StepVariant] = validateStepList(list, `${division} / ${VARIANT_LABEL[variant as StepVariant]}`, variant as StepVariant)
    }
    if (Object.keys(entry).length > 0) out[division] = entry
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * The list to use for this division and variant: what Settings saved if it is valid, else the built-in default. A saved list that no
 * longer validates (a step retired from the catalog) is ignored whole rather than half-applied. The caller drops disabled steps.
 */
export function resolveSteps(config: unknown, division: string | null | undefined, variant: StepVariant): StepSetting[] {
  const saved = division && config && typeof config === 'object' ? (config as ProgressStepsConfig)[division]?.[variant] : undefined
  if (saved) {
    try { return validateStepList(saved, 'saved steps', variant) } catch { /* fall through to the defaults */ }
  }
  return defaultSettings(variant)
}
