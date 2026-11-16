// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { AgingStatementResult } from '@/lib/apiClient'

const { agingStatement } = vi.hoisted(() => ({ agingStatement: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  agingStatement,
  graphqlErrorText: (err: unknown) => String((err as Error)?.message ?? err),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AgingStatementDialog } from './AgingStatementDialog'

const preview: AgingStatementResult = {
  preview: true, to: ['ap@acme.com'], cc: ['billing@bcatcorp.com'], subject: 'Aging report', body: 'Hi', filename: 'acme.pdf', url: 'https://s3/acme.pdf',
  statement: { rows: 2, totalCents: 150_000, companyName: 'BCAT', byBucket: {}, factoredExcluded: 1 },
}

describe('AgingStatementDialog previewOnly', () => {
  beforeEach(() => agingStatement.mockReset())

  it('shows recipients, subject, body and the statement PDF, has no Send button, and never asks to send', async () => {
    agingStatement.mockResolvedValue(preview)
    render(<AgingStatementDialog previewOnly customerId="c1" customerName="Acme" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Statement to').textContent).toContain('ap@acme.com'))
    expect(screen.getByLabelText('Statement subject').textContent).toBe('Aging report')
    expect(screen.getByTestId('statement-pdf-preview').getAttribute('src')).toBe('https://s3/acme.pdf')
    expect(screen.getByTestId('statement-preview-only')).toBeTruthy()
    expect(screen.getByTestId('statement-factored-note').textContent).toContain('OTR collects')
    expect(screen.queryByRole('button', { name: /^send/i })).toBeNull()
    expect(agingStatement).toHaveBeenCalledTimes(1)
    expect(agingStatement.mock.calls[0][0]).toEqual({ customerId: 'c1' })
  })
})
