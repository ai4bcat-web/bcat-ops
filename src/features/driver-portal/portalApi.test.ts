import { describe, it, expect } from 'vitest'
import { portal, uploadFile, usingMock, PortalError, type OnboardingState } from './portalApi'

// Exercises the full portal loop against the in-memory mock (no backend) — the
// offline stand-in for "test the portal loop on localhost with a mock token".
const TOKEN = 'MOCK'

function find(state: OnboardingState, key: string) {
  return state.checklist.find((c) => c.requirementKey === key)
}

describe('driver portal mock loop', () => {
  it('runs in mock mode when no API url is configured', () => {
    expect(usingMock).toBe(true)
  })

  it('walks invite → application → upload → e-sign and reflects status', async () => {
    // 1. Initial state
    let state = await portal<OnboardingState>(TOKEN, 'getOnboardingState')
    expect(state.firstName).toBe('Jane')
    expect(find(state, 'employment_application')).toBeTruthy()
    expect(find(state, 'cdl_copy')?.status).toBe('AWAITING_DRIVER')

    // 2. Upload a document → goes to PENDING_REVIEW
    const file = new File(['fake'], 'cdl.pdf', { type: 'application/pdf' })
    await uploadFile(TOKEN, 'cdl_copy', file)
    state = await portal<OnboardingState>(TOKEN, 'getOnboardingState')
    expect(find(state, 'cdl_copy')?.status).toBe('PENDING_REVIEW')

    // 3. Submit the application → employment_application PENDING_REVIEW
    await portal(TOKEN, 'submitApplication', { application: { driverId: 'self', legalName: 'Jane Hauler' } })
    state = await portal<OnboardingState>(TOKEN, 'getOnboardingState')
    expect(state.application.status).toBe('SUBMITTED')
    expect(find(state, 'employment_application')?.status).toBe('PENDING_REVIEW')

    // 4. E-sign an attestation item
    await portal(TOKEN, 'eSign', { requirementKey: 'drug_alcohol_policy_receipt', signatureName: 'Jane Hauler' })
    state = await portal<OnboardingState>(TOKEN, 'getOnboardingState')
    expect(find(state, 'drug_alcohol_policy_receipt')?.status).toBe('PENDING_REVIEW')

    // Progress should have moved off zero.
    expect(state.progressPct).toBeGreaterThan(0)
  })

  it('rejects an expired token with a friendly 410', async () => {
    await expect(portal('EXPIRED', 'getOnboardingState')).rejects.toMatchObject({
      status: 410,
    })
    await expect(portal('EXPIRED', 'getOnboardingState')).rejects.toBeInstanceOf(PortalError)
  })
})
