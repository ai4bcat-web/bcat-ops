// Portal API client. Talks to the onboarding-portal-api Function URL when
// VITE_ONBOARDING_API_URL is set; otherwise falls back to an in-memory mock so the
// whole loop can be walked on localhost (route /onboard/MOCK) without a deployed backend.
import { getDriverRequirements } from '@/lib/complianceRequirements'
import { AMAZON_DRIVER_TEMPLATE } from '@/lib/onboardingTemplates'
import type { DriverApplicationDraft } from '@/lib/schemas'

// requirementKey → phase, from the Amazon template (drives the mock's phase grouping).
const MOCK_PHASE_BY_KEY: Record<string, number> = Object.fromEntries(
  AMAZON_DRIVER_TEMPLATE.phases.flatMap((p) => p.entries.map((e) => [e.key, p.phase])),
)

export interface ChecklistItem {
  requirementKey: string
  label: string
  category: string
  /** 1-based onboarding phase; null for legacy/flat (non-phased) checklists. */
  phase?: number | null
  status: string
  required: boolean
  requiresDocument: boolean
  requiresExpiration: boolean
  driverActionable: boolean
  links?: { label: string; url: string }[] | null
  rejectionReason: string | null
}

export interface OnboardingState {
  firstName: string
  driverType: 'COMPANY' | 'OWNER_OPERATOR' | null
  progressPct: number
  /** Lowest phase not yet finalized — the only actionable phase; later phases are locked. */
  currentPhase?: number
  /** OnboardingTemplate.id, so the portal can label phases; null for flat checklists. */
  templateId?: string | null
  application: { status: string; draft: Partial<DriverApplicationDraft> | null }
  checklist: ChecklistItem[]
}

export class PortalError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const API_URL = import.meta.env.VITE_ONBOARDING_API_URL as string | undefined
export const usingMock = !API_URL

async function callApi<T>(token: string, action: string, payload?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, action, payload }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new PortalError(res.status, (data as { error?: string }).error ?? res.statusText)
  return data as T
}

export async function portal<T>(token: string, action: string, payload?: Record<string, unknown>): Promise<T> {
  if (usingMock) return mockPortal<T>(token, action, payload)
  return callApi<T>(token, action, payload)
}

/** Uploads a file for a requirement: presign → PUT → confirm. No-op PUT in mock mode. */
export async function uploadFile(
  token: string,
  requirementKey: string,
  file: File,
  expirationDate?: string,
): Promise<void> {
  const { uploadUrl, s3Key } = await portal<{ uploadUrl: string; s3Key: string }>(token, 'getUploadUrl', {
    requirementKey,
    contentType: file.type || 'application/octet-stream',
    fileName: file.name,
    size: file.size,
  })
  if (!usingMock) {
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } })
    if (!put.ok) throw new PortalError(put.status, 'Upload failed')
  }
  await portal(token, 'confirmUpload', { requirementKey, s3Key, expirationDate })
}

// ── In-memory mock (localhost / offline) ────────────────────────────────────────

interface MockState {
  firstName: string
  driverType: 'COMPANY' | 'OWNER_OPERATOR'
  checklist: ChecklistItem[]
  application: { status: string; draft: Partial<DriverApplicationDraft> | null }
}

let mock: MockState | null = null

function seedMock(): MockState {
  const reqs = getDriverRequirements('COMPANY').filter((r) => r.driverVisible)
  return {
    firstName: 'Jane',
    driverType: 'COMPANY',
    application: { status: 'DRAFT', draft: null },
    checklist: reqs.map((r) => ({
      requirementKey: r.key,
      label: r.label,
      category: r.category,
      phase: MOCK_PHASE_BY_KEY[r.key] ?? 1,
      status: r.required ? (r.driverActionable ? 'AWAITING_DRIVER' : 'PENDING') : 'NOT_APPLICABLE',
      required: r.required,
      requiresDocument: r.requiresDocument,
      requiresExpiration: r.requiresExpiration,
      driverActionable: r.driverActionable,
      links: r.links ? [...r.links] : null,
      rejectionReason: null,
    })),
  }
}

function progress(state: MockState): number {
  const required = state.checklist.filter((c) => c.required && c.status !== 'NOT_APPLICABLE')
  const done = required.filter((c) => c.status === 'COMPLETE' || c.status === 'WAIVED' || c.status === 'PENDING_REVIEW').length
  return required.length ? Math.round((done / required.length) * 100) : 0
}

// Lowest phase with a required item not yet finalized (mirrors the Lambda's gating).
function mockCurrentPhase(state: MockState): number {
  const DONE = ['COMPLETE', 'WAIVED', 'NOT_APPLICABLE']
  const phases = [...new Set(state.checklist.map((c) => c.phase ?? 1))].sort((a, b) => a - b)
  for (const p of phases) {
    const req = state.checklist.filter((c) => (c.phase ?? 1) === p && c.required)
    if (!req.every((c) => DONE.includes(c.status))) return p
  }
  return phases[phases.length - 1] ?? 1
}

async function mockPortal<T>(token: string, action: string, payload?: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 120)) // simulate latency
  if (token === 'EXPIRED') throw new PortalError(410, 'This link has expired')
  if (!mock) mock = seedMock()
  const p = (payload ?? {}) as Record<string, unknown>

  switch (action) {
    case 'getOnboardingState':
      return {
        firstName: mock.firstName,
        driverType: mock.driverType,
        progressPct: progress(mock),
        currentPhase: mockCurrentPhase(mock),
        templateId: AMAZON_DRIVER_TEMPLATE.id,
        application: mock.application,
        checklist: mock.checklist,
      } as T
    case 'saveApplicationDraft':
      mock.application = { status: 'DRAFT', draft: (p.draft as Partial<DriverApplicationDraft>) ?? null }
      return { ok: true } as T
    case 'submitApplication':
      mock.application = { status: 'SUBMITTED', draft: (p.application as Partial<DriverApplicationDraft>) ?? null }
      mock.checklist = mock.checklist.map((c) => c.requirementKey === 'employment_application' ? { ...c, status: 'PENDING_REVIEW' } : c)
      return { ok: true } as T
    case 'getUploadUrl':
      return { uploadUrl: 'mock://upload', s3Key: `mock/${p.requirementKey}/${Date.now()}` } as T
    case 'confirmUpload':
    case 'eSign':
      mock.checklist = mock.checklist.map((c) => c.requirementKey === p.requirementKey ? { ...c, status: 'PENDING_REVIEW', rejectionReason: null } : c)
      return { ok: true } as T
    default:
      throw new PortalError(400, `Unknown action: ${action}`)
  }
}
