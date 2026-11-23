// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { AuthContext } from '@/hooks/useAuth'
import { useIntakePermissions } from './useIntakePermissions'

function perms(email: string, groups: string[], over: { isAdmin?: boolean; isOwner?: boolean; pages?: string[] } = {}) {
  const value = {
    user: { userId: 'u', email, groups },
    loading: false,
    needsNewPassword: false,
    login: async () => { throw new Error('unused') },
    completeNewPassword: async () => {},
    logout: async () => {},
    isAdmin: over.isAdmin ?? false,
    isOwner: over.isOwner ?? false,
    hasPageAccess: (k: string) => (over.pages ?? []).includes(k),
  }
  const wrapper = ({ children }: { children: ReactNode }) => <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  return renderHook(() => useIntakePermissions(), { wrapper }).result.current
}

describe('useIntakePermissions', () => {
  it('the owner and the Cognito ADMIN group may delete', () => {
    expect(perms('ryne@bcatcorp.com', [], { isOwner: true, isAdmin: true }).isOwnerOrAdmin).toBe(true)
    expect(perms('x@bcatcorp.com', ['ADMIN'], { isAdmin: true }).isOwnerOrAdmin).toBe(true)
  })

  it('a legacy admin-e-mail account without the ADMIN group is not shown Delete (the server refuses it)', () => {
    const p = perms('dennis@bcatcorp.com', [], { isAdmin: true, pages: ['intakeReview'] })
    expect(p.isOwnerOrAdmin).toBe(false)
    expect(p.canReview).toBe(true)
  })

  it('a reviewer with the intakeReview grant can review but not delete', () => {
    const p = perms('rep@bcatcorp.com', ['page-intakeReview'], { pages: ['intakeReview'] })
    expect(p).toEqual({ isOwnerOrAdmin: false, canReview: true })
  })
})
