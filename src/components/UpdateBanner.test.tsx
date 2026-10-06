// @vitest-environment jsdom
/**
 * The "new version" banner. It exists because a long-lived SPA tab runs whatever JavaScript
 * it loaded, and the two things that would make it worse than nothing are showing it where
 * it cannot be read, and showing it when there is no update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const state = { available: false, reload: vi.fn() }
vi.mock('@/hooks/useAppUpdate', () => ({ useAppUpdate: () => state }))

const { UpdateBanner } = await import('./UpdateBanner')

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}><UpdateBanner /></MemoryRouter>,
  )
}

beforeEach(() => { state.available = false; state.reload = vi.fn() })

describe('the update banner', () => {
  it('says nothing when the tab is current', () => {
    at('/loads')
    expect(screen.queryByText(/new version/i)).toBeNull()
  })

  it('offers a reload when a new build is out', () => {
    state.available = true
    at('/loads')
    expect(screen.getByText(/new version of BCAT Ops/i)).toBeTruthy()
    expect(screen.getByText('Reload')).toBeTruthy()
  })

  it('does not show in the driver app', () => {
    /*
     * The PWA's service worker fetches the shell network-first and its bundles are content
     * hashed, so a driver gets a new build on their next load without being asked. The
     * driver app also has a fixed tab bar across the bottom, which a banner pinned there
     * would sit behind — the same thing that once hid every toast on that screen.
     */
    state.available = true
    at('/driver/paperwork')
    expect(screen.queryByText(/new version/i)).toBeNull()
  })

  it('stays dismissed once closed', () => {
    state.available = true
    at('/loads')
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText(/new version/i)).toBeNull()
  })
})
