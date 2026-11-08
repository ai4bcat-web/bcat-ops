import { describe, expect, it } from 'vitest'
import { decodeCheckCallNote, encodeCheckCallNote, toLogCheckCallInput } from './checkCallNote'
import type { Stop } from '@/types'

const draft = { city: 'Gary', state: 'IN', at: '2026-11-04T08:00', temperature: '34', note: 'rolling', message: 'AT_PICKUP', ediReason: 'NS', nextAt: '2026-11-04T14:00', nextNote: 'call back' }
const stops = [
  { id: 'p', type: 'pickup', sequence: 0 }, { id: 'p2', type: 'pickup', sequence: 1 }, { id: 'd', type: 'delivery', sequence: 2 },
] as unknown as Stop[]
const now = new Date('2026-11-04T20:00:00Z')

describe('check-call note encoding', () => {
  it('round-trips message, EDI reason, temperature and free text', () => {
    const note = encodeCheckCallNote({ message: 'ON_TIME', ediReason: 'NS', temperature: '-5', unit: 'C', note: 'all good' })
    expect(note.split('\n')[0]).toBe('[ah msg=ON_TIME edi=NS temp=-5C]')
    expect(decodeCheckCallNote(note)).toEqual({ message: 'ON_TIME', ediReason: 'NS', temperature: -5, unit: 'C', text: 'all good' })
  })
  it('a plain legacy or driver-app note decodes to free text only', () => {
    expect(decodeCheckCallNote('Driver says 2 hours out')).toEqual({ text: 'Driver says 2 hours out' })
    expect(decodeCheckCallNote(null)).toEqual({ text: '' })
  })
  it('no fields → no marker; total length is capped at 2000', () => {
    expect(encodeCheckCallNote({ note: ' hi ' })).toBe('hi')
    expect(() => encodeCheckCallNote({ message: 'ON_TIME', note: 'x'.repeat(2000) })).toThrow(/2000/)
  })
})

describe('Add Check Call → LOG_CHECK_CALL', () => {
  it('maps At Pickup to ARRIVED at the first pickup and encodes the note', () => {
    const input = toLogCheckCallInput(draft, { loadId: 'l1', expectedUpdatedAt: 'u', stops, tempUnit: 'F', now })
    expect(input).toMatchObject({ type: 'ARRIVED', stopId: 'p', city: 'Gary', state: 'IN', nextCheckCallNote: 'call back' })
    expect(decodeCheckCallNote(input.note)).toMatchObject({ message: 'AT_PICKUP', ediReason: 'NS', temperature: 34, unit: 'F', text: 'rolling' })
    expect(input.nextCheckCallAt).toBeTruthy()
  })
  it('Empty is DEPARTED at the last delivery; Breakdown is an INCIDENT; Remark is a NOTE', () => {
    const at = (message: string) => toLogCheckCallInput({ ...draft, message }, { loadId: 'l', expectedUpdatedAt: 'u', stops, now })
    expect(at('EMPTY')).toMatchObject({ type: 'DEPARTED', stopId: 'd' })
    expect(at('BREAKDOWN')).toMatchObject({ type: 'INCIDENT', incidentType: 'BREAKDOWN' })
    expect(at('REMARK').type).toBe('NOTE')
    expect(at('').type).toBe('NOTE')
  })
  it('refuses a future time with the server’s words', () => {
    expect(() => toLogCheckCallInput({ ...draft, at: '2026-11-09T08:00' }, { loadId: 'l', expectedUpdatedAt: 'u', stops, now }))
      .toThrow('A check call cannot be logged in the future')
  })
})
