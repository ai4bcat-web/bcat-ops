// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useAuditLog = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useAuditLog', () => ({ useAuditLog }))

import { AuditPage } from './AuditPage'

beforeEach(() => { useAuditLog.mockReset(); useAuditLog.mockReturnValue({ entries: [], loading: false }) })

const mount = (url: string) => render(<MemoryRouter initialEntries={[url]}><AuditPage /></MemoryRouter>)

describe('AuditPage ?entity=', () => {
  it('opens already filtered to the shipment id in the link, for every entity spelling', () => {
    mount('/tms/brokerage/audit?entity=sh-123')
    expect((screen.getByLabelText('Entity lookup') as HTMLInputElement).value).toBe('sh-123')
    const asked = useAuditLog.mock.calls.at(-1)![0] as Array<{ entityType: string; entityId: string }>
    expect(asked.length).toBeGreaterThan(0)
    expect(new Set(asked.map((e) => e.entityId))).toEqual(new Set(['sh-123']))
    expect(asked.map((e) => e.entityType)).toEqual(expect.arrayContaining(['Shipment', 'SHIPMENT']))
    expect(screen.getByText('Back to this session')).toBeTruthy()
  })

  it('without the param it shows this session only', () => {
    mount('/tms/brokerage/audit')
    expect(useAuditLog.mock.calls.at(-1)![0]).toBeUndefined()
    expect(screen.queryByText('Back to this session')).toBeNull()
  })
})
