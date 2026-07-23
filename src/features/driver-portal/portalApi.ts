// Portal API client. Talks to the onboarding-portal-api Function URL when
// VITE_ONBOARDING_API_URL is set; otherwise falls back to an in-memory mock so the
// whole loop can be walked on localhost (route /onboard/MOCK) without a deployed backend.
import { getDriverRequirements } from '@/lib/complianceRequirements'
import type { DriverApplicationDraft } from '@/lib/schemas'

export interface ChecklistItem {
  requirementKey: string
  label: string
  category: string
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
