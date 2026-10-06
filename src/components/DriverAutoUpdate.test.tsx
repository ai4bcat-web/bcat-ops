// @vitest-environment jsdom
/**
 * A driver should never have to sign out and back in to get a new build — which was never
 * what updated it anyway, only folklore that happened to coincide with a reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DriverAutoUpdate } from './DriverAutoUpdate'

const reload = vi.fn()
let available = false
vi.mock('@/hooks/useAppUpdate', () => ({ useAppUpdate: () => ({ available, reload }) }))

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

const at = (path: string) =>
  render(<MemoryRouter initialEntries={[path]}><DriverAutoUpdate /></MemoryRouter>)

beforeEach(() => { reload.mockClear(); available = false; setVisibility('visible') })
afterEach(() => { setVisibility('visible') })

describe('DriverAutoUpdate', () => {
  it('reloads when the driver brings the app back with a new build waiting', () => {
    available = true
    at('/driver/settlement')
    setVisibility('visible')
    expect(reload).toHaveBeenCalled()
  })

  it('does nothing when the build has not changed', () => {
    at('/driver/settlement')
    setVisibility('visible')
    expect(reload).not.toHaveBeenCalled()
  })

  it('never reloads out from under the scanner', () => {
    // Captured pages live in memory until they are sent; a reload would silently bin a
    // POD somebody just photographed at a dock.
    available = true
    at('/driver/scan')
    setVisibility('visible')
    expect(reload).not.toHaveBeenCalled()
  })

  it('leaves the staff app alone — that one asks first, on purpose', () => {
    available = true
    at('/loads')
    setVisibility('visible')
    expect(reload).not.toHaveBeenCalled()
  })

  it('waits for the foreground rather than reloading a backgrounded app', () => {
    available = true
    at('/driver/settlement')
    reload.mockClear()
    setVisibility('hidden')
    expect(reload).not.toHaveBeenCalled()
  })

  it('stops listening once it unmounts', () => {
    available = true
    const { unmount } = at('/driver/settlement')
    reload.mockClear()
    unmount()
    setVisibility('visible')
    expect(reload).not.toHaveBeenCalled()
  })
})
