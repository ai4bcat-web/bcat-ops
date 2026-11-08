// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationRecord } from '@/lib/integrations/types'

const api = vi.hoisted(() => ({
  listIntegrations: vi.fn(),
  listWorkflowExceptions: vi.fn(),
  listTruckLocations: vi.fn(),
  listFactoringItems: vi.fn(),
  validateIntegration: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)
vi.mock('@/hooks/useAppUpdate', () => ({ useAppUpdate: () => ({ available: false, reload: vi.fn() }) }))

const build = vi.hoisted(() => ({
  BUILD: { commit: 'abcdef1234', jobId: '137', branch: 'dev', builtAt: '2026-11-03T10:00:00Z', isDev: true },
}))
vi.mock('@/lib/buildInfo', () => build)

import { PlatformHealthPage } from './PlatformHealthPage'

function row(provider: string, patch: Partial<IntegrationRecord>): IntegrationRecord {
  return {
    id: provider, provider, kind: 'PROVIDER', mode: 'LIVE', credentialSource: 'STACK',
    status: 'CONNECTED', health: 'OK', ...patch,
  }
}

function draw() {
  return render(<MemoryRouter><PlatformHealthPage /></MemoryRouter>)
}

describe('PlatformHealthPage', () => {
  beforeEach(() => {
    build.BUILD.isDev = true
    api.listWorkflowExceptions.mockResolvedValue([])
    api.listTruckLocations.mockResolvedValue([])
    api.listFactoringItems.mockResolvedValue([])
    api.listIntegrations.mockResolvedValue([
      row('MOTIVE', { health: 'UNABLE_TO_VERIFY', healthReason: 'NEUTERED_ON_DEV' }),
      row('GMAIL', {}),
    ])
  })

  it('shows the dev banner and keeps neutered secrets out of "needs attention"', async () => {
    draw()
    expect(await screen.findByText('Dev stack')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('1 neutered on dev')).toBeInTheDocument())
    expect(screen.getByText('Needs attention').closest('.tms-kpi-card')).toHaveTextContent(/Needs attention\s*0/)
  })

  it('has no dev banner off dev', async () => {
    build.BUILD.isDev = false
    draw()
    await screen.findByText('Integrations connected')
    expect(screen.queryByText('Dev stack')).not.toBeInTheDocument()
  })

  it('counts a real failure as needing attention', async () => {
    api.listIntegrations.mockResolvedValue([row('SLACK', { health: 'INVALID_CREDENTIALS', healthReason: 'INVALID_CREDENTIALS' })])
    draw()
    await waitFor(() =>
      expect(screen.getByText('Needs attention').closest('.tms-kpi-card')).toHaveTextContent(/Needs attention\s*1/))
  })

  it('never calls the live credential check on its own', async () => {
    draw()
    await screen.findByText('Dev stack')
    await waitFor(() => expect(api.listIntegrations).toHaveBeenCalled())
    expect(api.validateIntegration).not.toHaveBeenCalled()
  })
})
