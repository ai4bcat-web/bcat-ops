// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { AgingStatementResult } from '@/lib/apiClient'

const { agingStatement } = vi.hoisted(() => ({ agingStatement: vi.fn() }))
vi.mock('@/lib/apiClient', () => ({
  agingStatement,
  graphqlErrorText: (err: unknown) => String((err as Error)?.message ?? err),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BulkAgingStatementDialog } from './BulkAgingStatementDialog'
import { statementBlocker } from '../statementBlocker'

const preview = (over: Partial<AgingStatementResult> = {}): AgingStatementResult => ({
  preview: true, to: ['ap@acme.com'], cc: ['billing@bcatcorp.com'], subject: 's', body: 'b', filename: 'f.pdf', url: 'u',
  statement: { rows: 2, totalCents: 150_000, companyName: 'BCAT', byBucket: {} },
  ...over,
})

describe('BulkAgingStatementDialog', () => {
  beforeEach(() => agingStatement.mockReset())

  it('previews every customer, blocks a missing invoice e-mail, and sends only the ready ones on confirm', async () => {
    agingStatement.mockImplementation(async (input: { customerId: string; send?: boolean } = { customerId: '' }) => {
      if (input.customerId === 'none') return preview({ to: [] })
      return input.send ? { ...preview(), preview: false, emailStatus: 'SENT', sentAt: '2026-11-14T12:00:00Z' } : preview()
    })
    const onDone = vi.fn()
    render(<BulkAgingStatementDialog customers={[{ id: 'acme', name: 'Acme' }, { id: 'none', name: 'No Mail' }]} onClose={vi.fn()} onDone={onDone} />)
    await waitFor(() => expect(screen.getByText('Missing invoice e-mail')).toBeTruthy())
    // Nothing is sent until the confirm button.
    expect(agingStatement.mock.calls.every(([i]) => !(i as { send?: boolean }).send)).toBe(true)
    const send = screen.getByTestId('bulk-statement-send')
    expect(send.textContent).toContain('Send 1')
    fireEvent.click(send)
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const sends = agingStatement.mock.calls.filter(([i]) => (i as { send?: boolean }).send)
    expect(sends.map(([i]) => (i as { customerId: string }).customerId)).toEqual(['acme'])
  })

  it('names why a statement cannot go', () => {
    expect(statementBlocker(preview({ to: [] }), null)).toBe('Missing invoice e-mail')
    expect(statementBlocker(preview({ statement: { rows: 0, totalCents: 0, companyName: 'B', byBucket: {} } }), null)).toBe('Nothing open')
    expect(statementBlocker(null, 'boom')).toBe('boom')
    expect(statementBlocker(preview(), null)).toBeNull()
  })
})
