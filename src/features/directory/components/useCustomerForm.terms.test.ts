// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCustomerForm } from './useCustomerForm'
import type { CustomerRecord } from '@/types/tms'

describe('customer payment terms are required', () => {
  it('a new customer starts at Net 30', () => {
    const { result } = renderHook(() => useCustomerForm(null))
    expect(result.current.value.paymentTermsDays).toBe('30')
    expect(result.current.errors.paymentTermsDays).toBeUndefined()
  })
  it('clearing the terms is an error', () => {
    const { result } = renderHook(() => useCustomerForm({ id: 'c1', name: 'Danisco', paymentTermsDays: 120 } as CustomerRecord))
    expect(result.current.value.paymentTermsDays).toBe('120')
    act(() => result.current.set('paymentTermsDays', ''))
    expect(result.current.errors.paymentTermsDays).toBe('Payment terms are required')
    act(() => result.current.set('paymentTermsDays', '7.5'))
    expect(result.current.errors.paymentTermsDays).toBe('Enter a whole number of days')
  })
})
