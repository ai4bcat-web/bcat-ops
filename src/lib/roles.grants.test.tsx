// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ROLES, groupsForProfile, rolePagesFor } from './roles'
import {
  ALJEX_SIGNOFF_PAGE, BILLING_RELEASE_PAGE, PER_USER_GRANT_PAGES, holdsPerUserGrant, pageOptions,
} from './navItems'
import { RequirePage } from '@/components/RequirePage'

// RequirePage-style gate fed by the group-only check the billing UI must use.
let groups: string[] = []
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    hasPageAccess: (key: string) => holdsPerUserGrant(groups, key),
    isOwner: true,
    isAdmin: true,
  }),
}))

function Gate({ page, children }: { page: string; children: ReactNode }) {
  return <MemoryRouter><RequirePage page={page}>{children}</RequirePage></MemoryRouter>
}

describe('per-user grant aljexSignoff', () => {
  it('is offered on the Users page as an assignable page', () => {
    expect(pageOptions().map((p) => p.key)).toContain(ALJEX_SIGNOFF_PAGE)
  })

  it('are held by no role, ADMIN included', () => {
    for (const role of ROLES) {
      for (const key of PER_USER_GRANT_PAGES) {
        expect(rolePagesFor(role)).not.toContain(key)
        expect(groupsForProfile({ role })).not.toContain(`page-${key}`)
      }
    }
  })

  it('reach a profile only through an explicit extra-page grant', () => {
    expect(groupsForProfile({ role: 'ADMIN', extraPages: [BILLING_RELEASE_PAGE] }))
      .toEqual(['ADMIN', 'page-billingRelease', 'role-ADMIN'])
    expect(groupsForProfile({ role: 'AR', extraPages: [ALJEX_SIGNOFF_PAGE] })).toContain('page-aljexSignoff')
  })

  it('holdsPerUserGrant ignores ADMIN and refuses non-grant keys', () => {
    expect(holdsPerUserGrant(['ADMIN', 'role-ADMIN'], ALJEX_SIGNOFF_PAGE)).toBe(false)
    expect(holdsPerUserGrant(['page-aljexSignoff'], ALJEX_SIGNOFF_PAGE)).toBe(true)
    expect(holdsPerUserGrant(['page-billingRelease'], ALJEX_SIGNOFF_PAGE)).toBe(false)
    expect(holdsPerUserGrant(['page-loads'], 'loads')).toBe(false)
  })

  it('RequirePage opens for the granted user and not for an ADMIN/owner without the grant', () => {
    groups = ['ADMIN', 'role-ADMIN']
    const { unmount } = render(<Gate page={ALJEX_SIGNOFF_PAGE}><p>signoff</p></Gate>)
    expect(screen.queryByText('signoff')).toBeNull()
    unmount()

    groups = ['page-aljexSignoff']
    render(<Gate page={ALJEX_SIGNOFF_PAGE}><p>signoff</p></Gate>)
    expect(screen.getByText('signoff')).toBeInTheDocument()
  })
})
