// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditLogEntry } from '@/types'

const fetchFor = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', () => ({ listAuditLogsFor: fetchFor }))

import { useAppStore } from '@/store/useAppStore'
import { useAuditLog } from './useAuditLog'

const row = (id: string, createdAt: string, entityId = 'l1'): AuditLogEntry =>
  ({ id, entityType: 'Load', entityId, action: 'update', user: 'u', changes: {}, createdAt })

describe('useAuditLog', () => {
  beforeEach(() => {
    fetchFor.mockReset()
    useAppStore.setState({ auditLog: [] })
  })

  it('returns only this-session entries without entities', () => {
    useAppStore.setState({ auditLog: [row('s1', '2030-01-01T00:00:00Z')] })
    const { result } = renderHook(() => useAuditLog())
    expect(result.current.entries.map((e) => e.id)).toEqual(['s1'])
    expect(fetchFor).not.toHaveBeenCalled()
  })

  it('merges fetched rows with newer local ones for the same entities only', async () => {
    fetchFor.mockResolvedValue([row('old', '2020-01-01T00:00:00Z')])
    const entities = [{ entityType: 'Load', entityId: 'l1' }]
    const { result } = renderHook(() => useAuditLog(entities))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      useAppStore.setState({
        auditLog: [row('new', '2999-01-01T00:00:00Z'), row('other', '2999-01-01T00:00:00Z', 'l2')],
      })
    })
    expect(result.current.entries.map((e) => e.id)).toEqual(['new', 'old'])
    expect(fetchFor).toHaveBeenCalledTimes(1)
  })
})
