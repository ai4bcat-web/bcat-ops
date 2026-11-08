import { describe, it, expect } from 'vitest'
import { pageSpecs } from '../devVerifyPerf.mjs'
import { ROW_HEIGHT, virtualWindow } from '../../src/features/tms/grid/denseGridModel.ts'

// The dense grid is virtualised: a populated list mounts a window of rows, never all 266. The
// perf probe's "first rows" threshold must be reachable by that window (it was 50 and the probe's
// 1000 px viewport mounts ~43, so /tms/shipments never reported rows).
describe('perf probe row threshold on the dense grid pages', () => {
  const specs = pageSpecs({ activeLowerBound: 266, trackingRows: 100 })
  const bodyPx = 1000 - 220 // viewport minus the shell, tabs, toolbar and header row
  const win = virtualWindow(266, ROW_HEIGHT.compact, 0, bodyPx, 8)
  const mounted = win.end - win.start
  it.each(['/tms/shipments', '/tms/shipments?list=all', '/tms/tracking'])('%s needs no more rows than the window mounts', (path) => {
    expect(specs[path].minRows).toBeGreaterThan(0)
    expect(specs[path].minRows).toBeLessThanOrEqual(mounted)
  })
})
