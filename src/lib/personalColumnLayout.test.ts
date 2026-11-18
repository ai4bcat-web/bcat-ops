import { describe, it, expect } from 'vitest'
import { isOwnPersonalTemplateId, isPersonalTemplateId, personalTemplateId, PERSONAL_LAYOUT_PREFIX } from './personalColumnLayout'

describe('personal column layout ids', () => {
  it('is stable, per list, per person, and ignores case and spaces in the e-mail', () => {
    const id = personalTemplateId('active', 'Dennis@bcatcorp.com')
    expect(id).toBe(personalTemplateId('active', ' dennis@bcatcorp.com '))
    expect(id).not.toBe(personalTemplateId('all', 'dennis@bcatcorp.com'))
    expect(id).not.toBe(personalTemplateId('active', 'alice@bcatcorp.com'))
    expect(id.startsWith(PERSONAL_LAYOUT_PREFIX)).toBe(true)
    expect(id.length).toBeLessThanOrEqual(64)
  })

  it('tells whose row an id is, and never matches the team default ids', () => {
    const mine = personalTemplateId('voided', 'dennis@bcatcorp.com')
    expect(isPersonalTemplateId(mine)).toBe(true)
    expect(isOwnPersonalTemplateId(mine, 'dennis@bcatcorp.com')).toBe(true)
    expect(isOwnPersonalTemplateId(mine, 'alice@bcatcorp.com')).toBe(false)
    expect(isPersonalTemplateId('shipments-team-default')).toBe(false)
    expect(isPersonalTemplateId('shipments-team-default-active')).toBe(false)
    expect(isOwnPersonalTemplateId(`${PERSONAL_LAYOUT_PREFIX}active-forged`, 'dennis@bcatcorp.com')).toBe(false)
  })
})
