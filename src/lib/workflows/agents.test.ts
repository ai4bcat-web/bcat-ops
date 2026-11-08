/**
 * The step vocabulary is what `beginStep` enforces and what the trace rail renders, so
 * a drift here silently changes what a run is allowed to do. The spec list is spelled
 * out again rather than imported, which is the only way the test can catch a change.
 */
import { describe, it, expect } from 'vitest'
import { AGENT_KEYS, isAgent, stepsOf } from './agents'
import { MAX_STEPS } from './runState'

const SPEC_STEPS: Record<string, string[]> = {
  TENDER: ['RECEIVE_EMAIL', 'CLASSIFY_EMAIL', 'PARSE_TENDER', 'MATCH_EMAIL_ENTITIES', 'MATCH_STOP', 'PROPOSE_TENDER'],
  QUOTE: ['RECEIVE_EMAIL', 'CLASSIFY_EMAIL', 'PARSE_QUOTE', 'MATCH_EMAIL_ENTITIES', 'PROPOSE_QUOTE'],
  AP: ['RECEIVE_EMAIL', 'CLASSIFY_EMAIL', 'PARSE_INVOICE', 'MATCH_EMAIL_ENTITIES', 'MATCH_DOCUMENTS', 'PROPOSE_BILL'],
  CAPACITY: ['RECEIVE_EMAIL', 'CLASSIFY_EMAIL', 'PARSE_CAPACITY', 'MATCH_EMAIL_ENTITIES', 'NOTE_CAPACITY'],
  WEBHOOK: ['RECEIVE_WEBHOOK', 'ROUTE_WEBHOOK'],
}

describe('AGENTS', () => {
  it('records the spec steps, in order, within the run cap', () => {
    for (const key of AGENT_KEYS) {
      expect(stepsOf(key)).toEqual(SPEC_STEPS[key])
      expect(stepsOf(key).length).toBeLessThanOrEqual(MAX_STEPS)
      expect(new Set(stepsOf(key)).size).toBe(stepsOf(key).length)
    }
  })
})

describe('isAgent', () => {
  it('accepts only the five agent keys', () => {
    expect(isAgent('TENDER')).toBe(true)
    expect(isAgent('tender')).toBe(false)
    expect(isAgent('toString')).toBe(false)
    expect(isAgent(null)).toBe(false)
  })
})
