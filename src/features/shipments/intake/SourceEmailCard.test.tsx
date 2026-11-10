// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { IntakeLoadRecord } from '@/types/intake'
import { SourceEmailCard } from './SourceEmailCard'

vi.mock('@/lib/apiClient', () => ({ getIntakePdfUrl: vi.fn(async (key: string) => `https://files.test/${key}`) }))

const row = (attachments: IntakeLoadRecord['attachments']) => ({
  id: 'il:1', runId: 'r1', subject: 'Tender', fromEmail: 'a@b.test', fromName: '', toAddress: null, toAddresses: [], receivedAt: '2026-11-09T10:00:00Z',
  bodyText: 'hello', parseState: 'PARSED', parseNote: null, attachments,
}) as unknown as IntakeLoadRecord

const renderCard = (a: IntakeLoadRecord['attachments']) => render(<MemoryRouter><SourceEmailCard row={row(a)} /></MemoryRouter>)

describe('SourceEmailCard attachment preview', () => {
  it('shows the PDF in full beside the form', async () => {
    renderCard([{ key: 'intake-attachments/x/ratecon.pdf', name: 'ratecon.pdf', contentType: 'application/pdf', size: 10 }])
    await waitFor(() => expect(screen.getByTestId('intake-preview-frame').getAttribute('src')).toBe('https://files.test/intake-attachments/x/ratecon.pdf'))
  })
  it('shows nothing when the e-mail had no viewable attachment', () => {
    renderCard([{ key: 'k', name: 'notes.txt', contentType: 'text/plain', size: 10 }])
    expect(screen.queryByTestId('intake-attachment-preview')).toBeNull()
    // ...and says why, instead of leaving an empty space where the PDF should be.
    expect(screen.getByTestId('intake-no-pdf').textContent).toMatch(/no PDF to show/)
  })
  it('has no "no PDF" note when the PDF is there', async () => {
    renderCard([{ key: 'k', name: 'ratecon.pdf', contentType: 'application/pdf', size: 10 }])
    expect(screen.queryByTestId('intake-no-pdf')).toBeNull()
  })
})
