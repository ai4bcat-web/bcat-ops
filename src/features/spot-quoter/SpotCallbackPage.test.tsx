// @vitest-environment jsdom
/**
 * The OAuth return carries a single-use `state`: the page must hand it to the server exactly
 * once, and must say so — with nothing connected — when Google refused or the page was
 * opened by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const api = vi.hoisted(() => ({ spotAction: vi.fn() }))
vi.mock('@/lib/apiClient', () => api)

import { SpotCallbackPage } from './SpotCallbackPage'

const draw = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tms/rates/spot/callback" element={<SpotCallbackPage />} />
        <Route path="/tms/rates/spot" element={<p>inbox</p>} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(() => vi.clearAllMocks())

describe('SpotCallbackPage', () => {
  it('exchanges the code once and returns to the inbox', async () => {
    api.spotAction.mockResolvedValue({ connection: {} })
    draw('/tms/rates/spot/callback?code=abc&state=xyz')
    expect(await screen.findByText('inbox')).toBeInTheDocument()
    expect(api.spotAction).toHaveBeenCalledTimes(1)
    expect(api.spotAction).toHaveBeenCalledWith('SPOT_OAUTH_FINISH', {
      code: 'abc', state: 'xyz', redirectUri: `${window.location.origin}/tms/rates/spot/callback`,
    })
  })

  it('shows the server’s refusal and stays put', async () => {
    api.spotAction.mockRejectedValue(new Error('Wrong Google account'))
    draw('/tms/rates/spot/callback?code=abc&state=xyz')
    expect(await screen.findByTestId('spot-callback-error')).toHaveTextContent('Wrong Google account')
    expect(screen.queryByText('inbox')).toBeNull()
  })

  it('does not call the server when Google reports an error or the answer is missing', async () => {
    draw('/tms/rates/spot/callback?error=access_denied')
    expect(await screen.findByTestId('spot-callback-error')).toHaveTextContent('access_denied')
    await waitFor(() => expect(api.spotAction).not.toHaveBeenCalled())
  })

  it('refuses a page opened without code and state', async () => {
    draw('/tms/rates/spot/callback')
    expect(await screen.findByTestId('spot-callback-error')).toBeInTheDocument()
    expect(api.spotAction).not.toHaveBeenCalled()
  })
})
