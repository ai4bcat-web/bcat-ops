import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pay rate must NEVER appear in the Ivan driver app. The hourly rate lives on DriverPaySetting
 * and is read only by the staff Employee Hours page. These fail the build if the names turn up
 * on the driver side, or if the driver app starts talking to AppSync (where DriverPaySetting
 * could be read) instead of its own Lambda.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

const DRIVER_SIDE = [...files('src/features/driver-app'), ...files('amplify/functions/driver-app-api')]

describe('the driver app never touches the hourly pay rate', () => {
  it('scans the driver app and its Lambda', () => {
    expect(DRIVER_SIDE.length).toBeGreaterThan(30)
  })

  it.each(['hourlyRate', 'hourlyRateHistory', 'hoursPay'])('%s appears nowhere under the driver app or driver-app-api', (name) => {
    const hits = DRIVER_SIDE.filter((f) => readFileSync(f, 'utf8').includes(name))
    expect(hits).toEqual([])
  })

  it('the driver app has no AppSync client, so it cannot read DriverPaySetting directly', () => {
    const hits = DRIVER_SIDE.filter((f) => f.startsWith('src/') && /from '(@\/lib\/apiClient|aws-amplify\/data)'|listDriverPaySettings/.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })
})
