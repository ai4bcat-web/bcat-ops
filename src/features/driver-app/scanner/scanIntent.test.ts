// @vitest-environment jsdom
/**
 * A driver tapped Send on a load, the scan screen flashed, and the app dropped back to the
 * settlement. The flow itself never navigates; iOS discards the web view while the phone's
 * file picker is in front of it, and a home-screen app relaunches at `start_url` — which
 * sends them to the settlement. This is what lets them be put back where they were.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { rememberScanIntent, readScanIntent, forgetScanIntent, scanIntentPath } from './scanIntent'

beforeEach(() => sessionStorage.clear())

describe('scan intent', () => {
  it('remembers the load and document a driver was sending', () => {
    rememberScanIntent({ kind: 'pod', pro: '14538' })
    expect(readScanIntent()).toMatchObject({ kind: 'pod', pro: '14538' })
  })

  it('resumes on the same screen, with the PRO already filled in', () => {
    rememberScanIntent({ kind: 'pod', pro: '14538' })
    expect(scanIntentPath(readScanIntent()!)).toBe('/driver/scan?kind=pod&pro=14538')
  })

  it('carries a submission when the POD is going onto one', () => {
    rememberScanIntent({ kind: 'pod', submissionId: 'sub-1' })
    expect(scanIntentPath(readScanIntent()!)).toBe('/driver/scan?kind=pod&submissionId=sub-1')
  })

  it('forgets it once the send is done', () => {
    // Or the next launch would drop them back into a job they finished.
    rememberScanIntent({ kind: 'pod', pro: '14538' })
    forgetScanIntent()
    expect(readScanIntent()).toBeNull()
  })

  it('ignores one left over from a while ago', () => {
    // This exists to rescue an interrupted task, not to haunt a driver with a PRO they
    // have long since dealt with.
    rememberScanIntent({ kind: 'pod', pro: '14538' })
    expect(readScanIntent(Date.now() + 16 * 60 * 1000)).toBeNull()
  })

  it('ignores anything it cannot make sense of, rather than throwing on launch', () => {
    // This runs on the app's first render. A crash here is a white screen.
    sessionStorage.setItem('bcat.driver.scanIntent', 'not json')
    expect(readScanIntent()).toBeNull()
    sessionStorage.setItem('bcat.driver.scanIntent', JSON.stringify({ kind: 'nonsense', at: Date.now() }))
    expect(readScanIntent()).toBeNull()
  })

  it('survives storage being unavailable at all', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    expect(() => rememberScanIntent({ kind: 'pod', pro: '1' })).not.toThrow()
    expect(readScanIntent()).toBeNull()
    expect(() => forgetScanIntent()).not.toThrow()
    Object.defineProperty(window, 'sessionStorage', original)
  })
})
