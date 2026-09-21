/**
 * Motive API client — open fault codes (DTCs) for the Fleet Manager Dashboard.
 *
 * Auth:  X-Api-Key header (org API key, never OAuth).
 * Base:  https://api.gomotive.com
 *
 * Endpoint used:
 *   GET /v1/fault_codes?status=open&per_page=100&page_no=N
 *     Each row is { fault_code: { id, code_label, code_description, ... } }.
 *     `vehicle.number` matches our TruckConfig.unitNumber.
 */

const BASE_URL = 'https://api.gomotive.com'

export interface MotiveFaultCode {
  faultId: string
  code: string
  description?: string
  sourceLabel?: string
  fmiDescription?: string
  faultType?: string
  occurrenceCount?: number
  firstObservedAt?: string
  lastObservedAt?: string
  vehicleNumber: string
  vehicleMake?: string
  vehicleModel?: string
  network?: string
}

interface RawFaultCodeVehicle {
  id: number
  number: string
  year?: string | number
  make?: string
  model?: string
  vin?: string
}

interface RawFaultCode {
  id: number
  code_label: string
  code_description?: string
  code?: string
  source_address_label?: string
  status: string
  first_observed_at?: string
  last_observed_at?: string
  type?: string
  fmi?: number
  fmi_description?: string
  occurrence_count?: number
  dtc_severity?: string | null
  network?: string
  eld_device?: unknown
  vehicle?: RawFaultCodeVehicle
}

interface RawFaultCodeEnvelope {
  fault_code: RawFaultCode
}

interface RawFaultCodeResponse {
  fault_codes?: RawFaultCodeEnvelope[]
  pagination?: {
    per_page: number
    page_no: number
    total?: number
  }
}

function headers(apiKey: string): Record<string, string> {
  return {
    'X-Api-Key':    apiKey,
    'Content-Type': 'application/json',
  }
}

async function getJson(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, { headers: headers(apiKey) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Motive API ${res.status} ${res.statusText} — ${url}\n${body}`)
  }
  return res.json()
}

/**
 * Fetch every open fault code from Motive (all pages).
 * Codes without a usable vehicle number are skipped.
 */
export async function fetchOpenFaultCodes(apiKey: string): Promise<MotiveFaultCode[]> {
  const out: MotiveFaultCode[] = []
  let page = 1
  while (true) {
    const url = `${BASE_URL}/v1/fault_codes?status=open&per_page=100&page_no=${page}`
    const data = await getJson(url, apiKey) as RawFaultCodeResponse
    const envelopes = data.fault_codes ?? []

    for (const envelope of envelopes) {
      const f = envelope?.fault_code
      if (!f) continue
      const vehicle = f.vehicle
      if (!vehicle?.number) continue

      // Motive sends JSON null for fields it has no value for (code_description is
      // routinely null on proprietary SPNs); normalise so callers see the optional
      // shape this module promises.
      out.push({
        faultId:         String(f.id),
        code:            f.code_label,
        description:     f.code_description ?? undefined,
        sourceLabel:     f.source_address_label ?? undefined,
        fmiDescription:  f.fmi_description ?? undefined,
        faultType:       f.type ?? undefined,
        occurrenceCount: typeof f.occurrence_count === 'number' ? f.occurrence_count : undefined,
        firstObservedAt: f.first_observed_at ?? undefined,
        lastObservedAt:  f.last_observed_at ?? undefined,
        vehicleNumber:   vehicle.number,
        vehicleMake:     vehicle.make ?? undefined,
        vehicleModel:    vehicle.model ?? undefined,
        network:         f.network ?? undefined,
      })
    }

    const perPage = data.pagination?.per_page ?? 100
    if (envelopes.length < perPage) break
    page++
  }
  return out
}
