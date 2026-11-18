import { describe, expect, it } from 'vitest'
import { flagAccessorialsFromMisc, type AccessorialFlagDeps, type MiscSubmission } from './accessorialFlag'

interface Harness {
  deps: AccessorialFlagDeps
  invoked: Array<{ systemCaller: string; action: string; input: Record<string, unknown> }>
  claims: Array<{ id: string; kinds: string[] }>
  logs: Array<{ level: string; message: string }>
}

function harness(sub: Partial<MiscSubmission> | null, extra: { loadId?: string | null; shipmentId?: string | null; claimed?: boolean; stops?: unknown[]; functionName?: string; invokeFails?: boolean } = {}): Harness {
  const invoked: Harness['invoked'] = []
  const claims: Harness['claims'] = []
  const logs: Harness['logs'] = []
  let claimedAlready = extra.claimed === true
  const row: MiscSubmission | null = sub ? { id: 'sub-1', loadId: 'load-1', stopId: 'stop-1', stopLabel: 'Pickup — INGREDION INC', ...sub } : null
  const deps: AccessorialFlagDeps = {
    functionName: extra.functionName ?? 'tms-shipment-actions',
    getSubmission: async () => row,
    linkToLoad: async () => extra.loadId ?? null,
    getLoad: async () => (extra.shipmentId === null ? { shipmentId: null } : ({ shipmentId: extra.shipmentId ?? 'shp-1', stops: extra.stops ?? [{ id: 'stop-1', type: 'pickup' }] } as never)),
    claim: async (id, kinds) => {
      if (claimedAlready) return false
      claimedAlready = true
      claims.push({ id, kinds })
      return true
    },
    invoke: async (payload) => {
      if (extra.invokeFails) throw new Error('lambda down')
      const args = payload.arguments as { action: string; input: string }
      invoked.push({ systemCaller: String(payload.systemCaller), action: args.action, input: JSON.parse(args.input) })
    },
    log: (level, message) => { logs.push({ level, message }) },
  }
  return { deps, invoked, claims, logs }
}

describe('flagAccessorialsFromMisc', () => {
  it('flags detention on the shipment when the driver note says "Detention pay"', async () => {
    const h = harness({ note: 'Detention pay' })
    await flagAccessorialsFromMisc(h.deps, 'Joshua Kly', 'sub-1')
    expect(h.invoked).toHaveLength(1)
    expect(h.invoked[0]).toMatchObject({ systemCaller: 'driver-app-api', action: 'FLAG_ACCESSORIAL_FROM_DRIVER_DOC' })
    expect(h.invoked[0].input).toMatchObject({
      shipmentId: 'shp-1', kind: 'DETENTION', submissionId: 'sub-1', driverName: 'Joshua Kly',
      stopId: 'stop-1', stopLabel: 'Pickup — INGREDION INC', stopType: 'pickup',
    })
    expect(String(h.invoked[0].input.note)).toContain('Detention pay')
    expect(h.claims).toEqual([{ id: 'sub-1', kinds: ['DETENTION'] }])
  })

  it('takes the stop type from the stop on the load over the label', async () => {
    const h = harness({ note: 'detention', stopLabel: 'Pickup — X' }, { stops: [{ id: 'stop-1', type: 'delivery' }] })
    await flagAccessorialsFromMisc(h.deps, 'Joshua Kly', 'sub-1')
    expect(h.invoked[0].input.stopType).toBe('delivery')
  })

  it('flags TONU too, and both when the note names both', async () => {
    const h = harness({ note: 'TONU + detention' })
    await flagAccessorialsFromMisc(h.deps, 'Joshua Kly', 'sub-1')
    expect(h.invoked.map((i) => i.input.kind)).toEqual(['DETENTION', 'TONU'])
  })

  it('does nothing for other notes, a blank note, or a note that rules it out', async () => {
    for (const note of ['seal number 4471', '', null, 'no detention', 'lumper receipt']) {
      const h = harness({ note })
      await flagAccessorialsFromMisc(h.deps, 'Joshua Kly', 'sub-1')
      expect(h.invoked).toHaveLength(0)
      expect(h.claims).toHaveLength(0)
    }
  })

  it('is once per submission: a retried complete does not raise a flag staff have since cleared', async () => {
    const h = harness({ note: 'Detention pay' }, { claimed: true })
    await flagAccessorialsFromMisc(h.deps, 'Joshua Kly', 'sub-1')
    expect(h.invoked).toHaveLength(0)
  })

  it('links a submission that was not matched to a load when it was started, and flags nothing when no load matches', async () => {
    const linked = harness({ note: 'Detention pay', loadId: null }, { loadId: 'load-9' })
    await flagAccessorialsFromMisc(linked.deps, 'Joshua Kly', 'sub-1')
    expect(linked.invoked).toHaveLength(1)

    const unmatched = harness({ note: 'Detention pay', loadId: null }, { loadId: null })
    await flagAccessorialsFromMisc(unmatched.deps, 'Joshua Kly', 'sub-1')
    expect(unmatched.invoked).toHaveLength(0)
    expect(unmatched.claims).toHaveLength(0)
    expect(unmatched.logs[0]).toMatchObject({ level: 'info' })
  })

  it('skips a load with no shipment, a missing submission, and a stack without the shipment Lambda', async () => {
    const noShipment = harness({ note: 'Detention pay' }, { shipmentId: null })
    await flagAccessorialsFromMisc(noShipment.deps, 'J', 'sub-1')
    expect(noShipment.invoked).toHaveLength(0)

    const missing = harness(null)
    await flagAccessorialsFromMisc(missing.deps, 'J', 'sub-1')
    expect(missing.invoked).toHaveLength(0)

    const noLambda = harness({ note: 'Detention pay' }, { functionName: '' })
    await flagAccessorialsFromMisc(noLambda.deps, 'J', 'sub-1')
    expect(noLambda.invoked).toHaveLength(0)
  })

  it('never throws: a failed hand-off is logged and the upload is untouched', async () => {
    const h = harness({ note: 'Detention pay' }, { invokeFails: true })
    await expect(flagAccessorialsFromMisc(h.deps, 'Joshua Kly', 'sub-1')).resolves.toBeUndefined()
    expect(h.logs.some((l) => l.level === 'error')).toBe(true)
  })
})
