import { describe, expect, it } from 'vitest'
import { resolveActor } from './auditActors'

const staff = [
  { id: 'u-1', email: 'dee.dispatch@bcatcorp.com', name: 'Dee Dispatch' },
  { id: 'u-2', email: 'sam@bcatcorp.com', name: null },
]

describe('resolveActor', () => {
  it('prints a person by display name, matched on login e-mail or profile id, case-insensitive', () => {
    expect(resolveActor('Dee.Dispatch@bcatcorp.com', staff)).toEqual({ kind: 'person', name: 'Dee Dispatch', label: 'Dee Dispatch' })
    expect(resolveActor('u-1', staff).label).toBe('Dee Dispatch')
  })

  it('falls back to the e-mail local part for a profile with no name, and for an unknown login', () => {
    expect(resolveActor('sam@bcatcorp.com', staff).kind).toBe('person')
    expect(resolveActor('sam@bcatcorp.com', staff).label).not.toContain('@')
    expect(resolveActor('new.hire@bcatcorp.com', staff).label).not.toContain('@')
    expect(resolveActor('5f1c0c2e-aaaa-bbbb-cccc-111122223333', staff).label).toBe('Unknown user')
  })

  it('names every automation the Lambdas write as an AI agent', () => {
    expect(resolveActor('workflow-agent', staff).label).toBe('AI agent · Workflow agent')
    expect(resolveActor('tracking-automation', staff).label).toBe('AI agent · Tracking agent')
    expect(resolveActor('carrier-inbox', staff).label).toBe('AI agent · Carrier inbox agent')
    expect(resolveActor('ap-inbox', staff).label).toBe('AI agent · AP inbox agent')
    expect(resolveActor('shipment-email-intake', staff).label).toBe('AI agent · Intake extractor')
    expect(resolveActor('intake', staff)).toMatchObject({ kind: 'agent', name: 'Intake extractor' })
  })

  it('scheduled jobs and empty actors are System; portals keep their own name', () => {
    expect(resolveActor('tms-dashboard-rollup', staff)).toEqual({ kind: 'system', name: 'System', label: 'System' })
    expect(resolveActor('', staff).label).toBe('System')
    expect(resolveActor(null, staff).label).toBe('System')
    expect(resolveActor('CARRIER_PORTAL', staff).label).toBe('Carrier portal')
  })

  it('the shared system@ address is disambiguated by the audit action, else System', () => {
    expect(resolveActor('system@bcatcorp.com', staff, 'FILE_INBOUND_OFFER').label).toBe('AI agent · Carrier inbox agent')
    expect(resolveActor('system@bcatcorp.com', staff, 'RUN_TRACKING_AUTOMATION').label).toBe('AI agent · Tracking agent')
    expect(resolveActor('system@bcatcorp.com', staff, 'SOMETHING_ELSE').label).toBe('System')
    expect(resolveActor('toString', staff).kind).toBe('person')
  })
})
