// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DriverLoginPage from './DriverLoginPage'

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

globalThis.DOMRect ??= class {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
} as never

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const signIn = vi.fn()
const forgotPassword = vi.fn()
const confirmForgotPassword = vi.fn()

vi.mock('./useDriverAuth', () => ({
  useDriverAuth: () => ({ signIn, forgotPassword, confirmForgotPassword }),
}))

function renderLogin(ua = '', standalone = false) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
  Object.defineProperty(window.navigator, 'standalone', {
    value: standalone,
    configurable: true,
  })
  return render(
    <MemoryRouter>
      <DriverLoginPage />
    </MemoryRouter>,
  )
}

describe('DriverLoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows platform-specific iOS Add to Home Screen steps for an iPhone user agent', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
    renderLogin(ua)

    expect(screen.getByRole('heading', { name: /Add to Home Screen/i })).toBeInTheDocument()
    expect(screen.getByText(/Share button/)).toBeInTheDocument()
    expect(screen.getByText(/square with an arrow/)).toBeInTheDocument()
  })

  it('shows a real Install app button after the beforeinstallprompt event fires', async () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'
    renderLogin(ua)

    expect(screen.queryByRole('button', { name: /Install app/i })).not.toBeInTheDocument()

    const prompt = vi.fn().mockResolvedValue(undefined)
    const event = new Event('beforeinstallprompt', { bubbles: true, cancelable: true })
    Object.assign(event, { prompt })

    window.dispatchEvent(event)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Install app/i })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Install app/i }))
    await waitFor(() => expect(prompt).toHaveBeenCalled())
  })

  it('hides install hints when running standalone', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
    renderLogin(ua, true)

    expect(screen.queryByRole('heading', { name: /Add to Home Screen/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Share button/)).not.toBeInTheDocument()
  })

  it('shows plain-language help text under the email field', () => {
    renderLogin()

    expect(screen.getByText(/Use the same email dispatch has on file/)).toBeInTheDocument()
  })

  it('replaces raw Cognito errors with a human login failure message', async () => {
    signIn.mockRejectedValue(new Error('User does not exist.'))
    renderLogin()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'unknown@example.com' } })
    fireEvent.change(document.getElementById('driver-password')!, { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }))

    await waitFor(() => {
      expect(screen.getByText(/We don't recognize that email or password/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/User does not exist/i)).not.toBeInTheDocument()
  })
})
