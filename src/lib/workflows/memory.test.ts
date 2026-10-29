/**
 * A memory revision is cited on every run that read it, so "bumped" has to mean the
 * words changed and nothing else. `redactForPrompt` is the last thing between a
 * forwarded e-mail and a model call, and between an exception and the Errors tab.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DAILY_RUN_CAP,
  MEMORY_MAX,
  agentEnabled,
  bumpMemory,
  dailyRunCapOf,
  memoryPromptFor,
  memoryRevisionsFor,
  redactForPrompt,
  validateAiAgents,
  validatePartyMemory,
} from './memory'
import type { AgentMemory } from '../../types/tms'

const BY = 'ryne@bcatcorp.com'
const T1 = '2026-10-29T14:00:00.000Z'
const T2 = '2026-10-30T09:00:00.000Z'

const PRIOR: AgentMemory = { markdown: 'Always confirm the appointment.', revision: 3, updatedAt: T1, updatedBy: BY }

describe('bumpMemory', () => {
  it('bumps the revision only when the words change', () => {
    expect(bumpMemory(PRIOR, '  Always confirm the appointment.  ', BY, T2)).toBe(PRIOR)
    const changed = bumpMemory(PRIOR, 'Always confirm the appointment and the PO.', BY, T2)
    expect(changed.revision).toBe(4)
    expect(changed.updatedAt).toBe(T2)
  })

  it('starts at revision 1 when there was nothing before', () => {
    expect(bumpMemory(null, 'First note', BY, T1).revision).toBe(1)
  })

  it('refuses memory over the cap', () => {
    expect(() => bumpMemory(null, 'x'.repeat(MEMORY_MAX + 1), BY, T1)).toThrow(/over 20000/)
  })
})

describe('redactForPrompt', () => {
  it('strips a token-shaped string and a card-shaped number', () => {
    const text = 'key sk-abcdef0123456789abcdef and card 4111 1111 1111 1111 ok'
    const out = redactForPrompt(text)
    expect(out).not.toContain('sk-abcdef0123456789abcdef')
    expect(out).not.toContain('4111 1111 1111 1111')
    expect(out).toContain('[redacted]')
    expect(out).toContain('ok')
  })

  it('strips an AWS key pair, in both of its shapes', () => {
    const out = redactForPrompt('id AKIAIOSFODNN7EXAMPLE secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('wJalrXUtnFEMI')
    expect(out).not.toContain('bPxRfiCYEXAMPLEKEY')
    expect(out).toContain('end')
  })

  it('strips a credential that is only recognisable from what it is called', () => {
    const out = redactForPrompt('login below\npassword: hunter2\nthanks')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('thanks')
  })

  it('leaves a phone number and ordinary prose alone', () => {
    expect(redactForPrompt('call 312-555-0147 about the reefer')).toBe('call 312-555-0147 about the reefer')
  })
})

describe('validateAiAgents', () => {
  it('bumps what changed and carries the rest forward untouched', () => {
    const first = validateAiAgents(
      { general: { markdown: 'Never quote a rate.' }, dailyRunCap: 50, QUOTE: { enabled: true, inbox: 'quotes@bcatcorp.com' } },
      null,
      BY,
      T1,
    )
    expect(first.general?.revision).toBe(1)
    expect(first.dailyRunCap).toBe(50)

    const second = validateAiAgents({ TENDER: { instructions: { markdown: 'Read the Appt line.' } } }, first, BY, T2)
    expect(second.general?.revision).toBe(1)
    expect(second.QUOTE?.inbox).toBe('quotes@bcatcorp.com')
    expect(second.TENDER?.instructions?.revision).toBe(1)
  })

  it('refuses a cap and an inbox that are not what they claim to be', () => {
    expect(() => validateAiAgents({ dailyRunCap: 0 }, null, BY, T1)).toThrow(/dailyRunCap/)
    expect(() => validateAiAgents({ AP: { inbox: 'not-an-address' } }, null, BY, T1)).toThrow(/address/)
    expect(() => validateAiAgents('nope', null, BY, T1)).toThrow(/object/)
  })
})

describe('validatePartyMemory', () => {
  it('bumps each block on its own', () => {
    const first = validatePartyMemory({ general: 'Ships out of Oakley.' }, null, BY, T1)
    const second = validatePartyMemory({ general: 'Ships out of Oakley.', TENDER: 'PO goes in Pro #.' }, first, BY, T2)
    expect(second.general?.revision).toBe(1)
    expect(second.TENDER?.revision).toBe(1)
  })
})

describe('memoryPromptFor and memoryRevisionsFor', () => {
  it('prints only the sections that have words, in spec order', () => {
    const org = validateAiAgents(
      {
        general: { markdown: 'House rules.' },
        TENDER: { instructions: { markdown: 'Tender rules.' }, memory: { markdown: 'Batory sends two PDFs.' } },
      },
      null,
      BY,
      T1,
    )
    const party = validatePartyMemory({ TENDER: 'Party tender rules.' }, null, BY, T1)

    const prompt = memoryPromptFor(org, party, 'TENDER')
    expect(prompt).toBe(
      '## Organization instructions\nHouse rules.\n\n'
      + '## Tender instructions\nTender rules.\n\n'
      + '## Tender memory\nBatory sends two PDFs.\n\n'
      + '## Party Tender notes\nParty tender rules.',
    )
    expect(memoryRevisionsFor(org, party, 'TENDER')).toEqual({
      org: 1, orgAgent: 1, orgAgentMemory: 1, party: null, partyAgent: 1,
    })
    expect(memoryPromptFor(null, null, 'QUOTE')).toBe('')
  })
})

describe('dailyRunCapOf and agentEnabled', () => {
  it('defaults to on and to the standing cap', () => {
    expect(dailyRunCapOf(null)).toBe(DEFAULT_DAILY_RUN_CAP)
    expect(dailyRunCapOf({ dailyRunCap: 10 })).toBe(10)
    expect(agentEnabled(null, 'AP')).toBe(true)
    expect(agentEnabled({ AP: { enabled: false } }, 'AP')).toBe(false)
    expect(agentEnabled({ AP: { enabled: false } }, 'QUOTE')).toBe(true)
  })
})
