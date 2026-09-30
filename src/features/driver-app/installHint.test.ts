import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { detectInstallPlatform, getInstallHint, isStandalone } from './installHint'

const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.92 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

describe('detectInstallPlatform', () => {
  it('detects iOS Safari', () => {
    expect(detectInstallPlatform(IOS_SAFARI)).toBe('ios-safari')
  })

  it('detects iOS Chrome as a separate platform that cannot install', () => {
    expect(detectInstallPlatform(IOS_CHROME)).toBe('ios-chrome')
  })

  it('detects Android Chrome', () => {
    expect(detectInstallPlatform(ANDROID_CHROME)).toBe('android')
  })

  it('falls back to desktop for unknown user agents', () => {
    expect(detectInstallPlatform(DESKTOP_CHROME)).toBe('desktop')
    expect(detectInstallPlatform('')).toBe('desktop')
  })
})

describe('getInstallHint', () => {
  it('gives iOS Safari the Share → Add to Home Screen steps', () => {
    const hint = getInstallHint(IOS_SAFARI)
    expect(hint.platform).toBe('ios-safari')
    expect(hint.canInstall).toBe(true)
    expect(hint.title).toBe('Add to Home Screen')
    expect(hint.steps[0]).toMatch(/Share button/)
    expect(hint.steps[1]).toMatch(/Add to Home Screen/)
  })

  it('tells iOS Chrome users to switch to Safari', () => {
    const hint = getInstallHint(IOS_CHROME)
    expect(hint.platform).toBe('ios-chrome')
    expect(hint.canInstall).toBe(false)
    expect(hint.title).toBe('Open in Safari')
    expect(hint.steps.some((s) => /Safari/.test(s))).toBe(true)
  })

  it('gives Android the three-dot → Install app steps', () => {
    const hint = getInstallHint(ANDROID_CHROME)
    expect(hint.platform).toBe('android')
    expect(hint.canInstall).toBe(true)
    expect(hint.title).toBe('Install app')
    expect(hint.steps[0]).toMatch(/three-dot menu/)
    expect(hint.steps[1]).toMatch(/Install app|Add to Home screen/)
  })
})

describe('isStandalone', () => {
  it('returns true when navigator.standalone is true', () => {
    expect(isStandalone({ standalone: true }, vi.fn())).toBe(true)
  })

  it('returns true when display-mode: standalone matches', () => {
    const matchMedia = (query: string) => ({
      matches: query === '(display-mode: standalone)',
    })
    expect(isStandalone({}, matchMedia)).toBe(true)
  })

  it('returns false when neither standalone flag is set', () => {
    const matchMedia = () => ({ matches: false })
    expect(isStandalone({}, matchMedia)).toBe(false)
  })

  it('returns false with no arguments in a node-like environment', () => {
    expect(isStandalone(undefined, undefined)).toBe(false)
  })
})
