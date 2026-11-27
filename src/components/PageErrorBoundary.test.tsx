// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageErrorBoundary } from './PageErrorBoundary'
import { isChunkLoadError, reloadForStaleChunk } from '@/lib/staleChunk'

function Boom({ message }: { message: string }): never { throw new Error(message) }

describe('PageErrorBoundary', () => {
  const reload = vi.fn()
  beforeEach(() => {
    reload.mockClear()
    window.sessionStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('shows what failed and a Reload button instead of a blank screen', () => {
    render(<PageErrorBoundary><Boom message="Cannot read properties of undefined (reading 'company')" /></PageErrorBoundary>)
    expect(screen.getByTestId('page-error')).toBeInTheDocument()
    expect(screen.getByText(/reading 'company'/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('a page chunk that no longer exists after a deploy reloads once on its own, and says why if it still fails', () => {
    const msg = 'Failed to fetch dynamically imported module: https://ops.bcatcorp.com/assets/ShipmentFormPage-abc.js'
    expect(isChunkLoadError(new Error(msg))).toBe(true)
    render(<PageErrorBoundary><Boom message={msg} /></PageErrorBoundary>)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('BCAT Ops was updated')).toBeInTheDocument()
    // a second failure inside the guard window does not loop
    expect(reloadForStaleChunk()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('renders its children untouched when nothing fails', () => {
    render(<PageErrorBoundary><p>fine</p></PageErrorBoundary>)
    expect(screen.getByText('fine')).toBeInTheDocument()
  })
})
