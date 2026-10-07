// @vitest-environment jsdom
/**
 * A driver should never have to sign out and back in — or know what a reload is — to get
 * the current build. These pin the policy and the three hooks that make it automatic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const registerSW = vi.fn()
vi.mock('virtual:pwa-register', () => ({ registerSW: (o: unknown) => registerSW(o) }))

const { shouldReloadForUpdate, SW_UPDATED_MESSAGE } = await import('./swUpdate')

/** A fake window with just enough of location / navigator.serviceWorker / document. */
function fakeWindow(pathname: string, withSW = true) {
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const docListeners: Record<string, Array<() => void>> = {}
  let visibility: 'visible' | 'hidden' = 'visible'
  const win = {
    location: { pathname, reload: vi.fn() },
    navigator: withSW ? {
      serviceWorker: {
        addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn) },
      },
    } : {},
    document: {
      get visibilityState() { return visibility },
      addEventListener: (type: string, fn: () => void) => { (docListeners[type] ??= []).push(fn) },
    },
  }
  return {
    win: win as unknown as Window,
    fire: (type: string, e: unknown = {}) => (listeners[type] ?? []).forEach((fn) => fn(e)),
    setVisible: (v: 'visible' | 'hidden') => { visibility = v; (docListeners.visibilitychange ?? []).forEach((fn) => fn()) },
    reload: win.location.reload,
    hasListener: (type: string) => (listeners[type]?.length ?? 0) > 0,
  }
}

beforeEach(() => { registerSW.mockReset() })

describe('shouldReloadForUpdate — the policy', () => {
  it('reloads an ordinary driver page', () => {
    expect(shouldReloadForUpdate('/driver/settlement')).toBe(true)
    expect(shouldReloadForUpdate('/driver/paperwork')).toBe(true)
    expect(shouldReloadForUpdate('/driver')).toBe(true)
  })

  it('never reloads the scanner — captured pages live in memory until sent', () => {
    expect(shouldReloadForUpdate('/driver/scan')).toBe(false)
    expect(shouldReloadForUpdate('/driver/scan?kind=POD')).toBe(false)
  })

  it('leaves the staff app alone; it has a banner and asks first on purpose', () => {
    expect(shouldReloadForUpdate('/loads')).toBe(false)
    expect(shouldReloadForUpdate('/')).toBe(false)
  })
})

describe('registerDriverServiceWorker — the wiring', () => {
  // The module keeps a once-only latch; each test needs a fresh module instance.
  async function fresh() {
    vi.resetModules()
    vi.doMock('virtual:pwa-register', () => ({ registerSW: (o: unknown) => registerSW(o) }))
    return await import('./swUpdate')
  }

  it('reloads when a new worker takes control of a settlement page', async () => {
    const m = await fresh()
    const w = fakeWindow('/driver/settlement')
    m.registerDriverServiceWorker(w.win)
    w.fire('controllerchange')
    expect(w.reload).toHaveBeenCalledTimes(1)
  })

  it('does NOT reload the scanner when a new worker takes control', async () => {
    const m = await fresh()
    const w = fakeWindow('/driver/scan')
    m.registerDriverServiceWorker(w.win)
    w.fire('controllerchange')
    expect(w.reload).not.toHaveBeenCalled()
  })

  it('answers the worker’s Safari-path message by reloading', async () => {
    // Safari has no WindowClient.navigate, so the worker posts instead of navigating.
    const m = await fresh()
    const w = fakeWindow('/driver/paperwork')
    m.registerDriverServiceWorker(w.win)
    w.fire('message', { data: { type: SW_UPDATED_MESSAGE } })
    expect(w.reload).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated worker messages', async () => {
    const m = await fresh()
    const w = fakeWindow('/driver/paperwork')
    m.registerDriverServiceWorker(w.win)
    w.fire('message', { data: { type: 'SOMETHING_ELSE' } })
    w.fire('message', { data: null })
    expect(w.reload).not.toHaveBeenCalled()
  })

  it('asks for an update every time the app comes back to the foreground', async () => {
    const m = await fresh()
    const w = fakeWindow('/driver/settlement')
    m.registerDriverServiceWorker(w.win)
    const opts = registerSW.mock.calls[0][0] as { immediate: boolean; onRegisteredSW: (u: string, r: unknown) => void }
    expect(opts.immediate).toBe(true)
    const update = vi.fn().mockResolvedValue(undefined)
    opts.onRegisteredSW('/sw.js', { update })
    w.setVisible('hidden')
    expect(update).not.toHaveBeenCalled()
    w.setVisible('visible')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a staff page', async () => {
    const m = await fresh()
    const w = fakeWindow('/loads')
    m.registerDriverServiceWorker(w.win)
    expect(registerSW).not.toHaveBeenCalled()
    expect(w.hasListener('controllerchange')).toBe(false)
  })

  it('does nothing where there is no service worker API', async () => {
    const m = await fresh()
    const w = fakeWindow('/driver/settlement', false)
    expect(() => m.registerDriverServiceWorker(w.win)).not.toThrow()
    expect(registerSW).not.toHaveBeenCalled()
  })

  it('registers once, however many times it is called', async () => {
    const m = await fresh()
    const w = fakeWindow('/driver/settlement')
    m.registerDriverServiceWorker(w.win)
    m.registerDriverServiceWorker(w.win)
    expect(registerSW).toHaveBeenCalledTimes(1)
    w.fire('controllerchange')
    expect(w.reload).toHaveBeenCalledTimes(1)
  })
})
