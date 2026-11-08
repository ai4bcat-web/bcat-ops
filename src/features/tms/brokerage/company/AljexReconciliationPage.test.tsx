// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReconJobSummary, ReconPage } from '@/lib/aljexReconcile'

const auth = vi.hoisted(() => ({ grant: false }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPageAccess: (k: string) => k === 'aljexSignoff' && auth.grant }) }))

const job: ReconJobSummary = {
  id: 'aljexrec:AP:1', entity: 'AP', status: 'APPLIED', sourceJobId: 's', asOf: '2026-11-07', createdAt: '2026-11-07T10:00:00Z', createdBy: 'a@example.com',
  finishedAt: null, error: null, reportPrefix: null, counts: null, stats: { total: 1, decided: 0, undecided: 1, openBalance: 0, approved: 0 }, signoff: null,
}
const page: ReconPage = {
  job,
  report: { entity: 'AP', generatedAt: 't', asOf: '2026-11-07', sourceJobId: 's', counts: { aljexRows: 1, bcatRows: 0, matched: 0, aljexOnly: 1, bcatOnly: 0, mismatched: 0, diffs: 1 }, excluded: {}, notes: [], money: null },
  total: 1,
  offset: 0,
  rows: [{ key: 'ALJEX_ONLY|7003-V3|', kind: 'ALJEX_ONLY', ref: '7003-V3', name: 'Carrier C', field: null, fieldLabel: 'Open bill in Aljex only', aljex: '80.00', bcat: null, diffCents: -8000, decision: null }],
}
vi.mock('@/lib/apiClient', () => ({
  listAljexReconcile: async () => ({ jobs: [job] }),
  listAljexImports: async () => [],
  getAljexReconcile: async () => page,
  startAljexReconcile: async () => ({ job }),
  decideAljexReconcile: async () => ({ job, decided: 1 }),
  signoffAljexReconcile: async () => ({ job }),
}))

import { AljexReconciliationPage } from './AljexReconciliationPage'

beforeEach(() => { auth.grant = false })

async function openReport() {
  render(<AljexReconciliationPage />)
  const open = await screen.findByRole('button', { name: 'Open' })
  open.click()
  await screen.findByTestId('recon-rows')
}

describe('AljexReconciliationPage', () => {
  it('shows the differences read-only without the grant: no decision form, sign-off disabled', async () => {
    await openReport()
    expect(screen.getByText('Carrier C')).toBeInTheDocument()
    expect(screen.queryByText('Reason (required)')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign off' })).toBeDisabled())
  })

  it('offers the decision form to the grant holder but keeps sign-off disabled while rows are undecided', async () => {
    auth.grant = true
    await openReport()
    expect(await screen.findByText('Reason (required)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign off' })).toBeDisabled()
  })
})
