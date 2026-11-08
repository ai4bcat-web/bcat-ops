// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { IconKeyDialog } from './IconKeyDialog'
import { AlertCircle } from 'lucide-react'

const TONES = [
  { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED'] },
  { key: 'open', label: 'Open', statuses: ['OPEN'] },
  { key: 'voided', label: 'Voided', statuses: ['VOIDED', 'CANCELED'] },
]

const EXCEPTIONS = [
  { icon: <AlertCircle size={16} />, meaning: 'Open incident' },
]

describe('IconKeyDialog', () => {
  it('lists every tone it is given', () => {
    render(<IconKeyDialog open onOpenChange={vi.fn()} tones={TONES} exceptions={EXCEPTIONS} />)
    expect(screen.getByText('Delivered')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getByText('Voided')).toBeInTheDocument()
    expect(screen.getByText('DELIVERED')).toBeInTheDocument()
  })

  it('lists exception meanings', () => {
    render(<IconKeyDialog open onOpenChange={vi.fn()} tones={TONES} exceptions={EXCEPTIONS} />)
    expect(screen.getByText('Open incident')).toBeInTheDocument()
  })

  it('closes through the close button', () => {
    const onOpenChange = vi.fn()
    render(<IconKeyDialog open onOpenChange={onOpenChange} tones={TONES} exceptions={EXCEPTIONS} />)
    fireEvent.click(screen.getByRole('button', { name: /^Done$/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
