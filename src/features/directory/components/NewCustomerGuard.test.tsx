// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CustomerFormValue } from './useCustomerForm'

const lookup = vi.fn()
vi.mock('@/lib/otrClient', () => ({ lookupCustomerByMc: (mc: string) => lookup(mc) }))

import { CustomerMcLookup, DuplicateCustomerNotice } from './NewCustomerGuard'
import { useNewCustomerGuard } from './useNewCustomerGuard'

const existing = [{ id: 'cus-a', name: 'ADDISON TRANSPORTATION, INC.', mcNumber: '326834' }]

function Harness({ isAdmin = false, onOpen = () => {} }: { isAdmin?: boolean; onOpen?: (id: string) => void }) {
  const [value, setValue] = useState({ name: '', mcNumber: '', dotNumber: '' } as CustomerFormValue)
  const set = <K extends keyof CustomerFormValue>(key: K, v: CustomerFormValue[K]) => setValue((prev) => ({ ...prev, [key]: v }))
  const guard = useNewCustomerGuard({ value, isNew: true, existing, isAdmin })
  return (
    <>
      <CustomerMcLookup value={value} set={set} />
      <input aria-label="Name" value={value.name} onChange={(e) => set('name', e.target.value)} />
      <DuplicateCustomerNotice guard={guard} onOpenExisting={onOpen} />
      <output data-testid="name">{value.name}</output>
      <output data-testid="blocked">{String(guard.blocked)}</output>
      <output data-testid="override">{guard.overrideReason ?? ''}</output>
    </>
  )
}

describe('New customer: look up by MC', () => {
  it('fills the name from OTR and shows its verdict', async () => {
    lookup.mockResolvedValue({ found: true, mcNumber: '764581', name: 'American Logistics Group', decision: 'APPROVED', noBuy: false, otrId: '759', message: '' })
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('MC number'), { target: { value: '764581' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('American Logistics Group'))
    expect(screen.getByTestId('customer-mc-result').textContent).toContain('Approved by OTR')
    expect(lookup).toHaveBeenCalledWith('764581')
  })

  it('says to enter by hand when OTR does not know the MC', async () => {
    lookup.mockResolvedValue({ found: false, mcNumber: '1', name: null, decision: 'NOT FOUND', noBuy: false, otrId: null, message: 'OTR has no customer with MC 1' })
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('MC number'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await waitFor(() => expect(screen.getByTestId('customer-mc-result').textContent).toContain('Enter the customer by hand'))
  })
})

describe('New customer: duplicates', () => {
  it('blocks a duplicate MC and offers to open the existing customer, with no override', () => {
    const onOpen = vi.fn()
    render(<Harness isAdmin onOpen={onOpen} />)
    fireEvent.change(screen.getByLabelText('MC number'), { target: { value: '326834' } })
    expect(screen.getByTestId('duplicate-customer').textContent).toContain('ADDISON TRANSPORTATION, INC. (MC 326834) — same MC number')
    expect(screen.getByTestId('blocked').textContent).toBe('true')
    expect(screen.queryByRole('button', { name: /different company/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open existing' }))
    expect(onOpen).toHaveBeenCalledWith('cus-a')
  })

  it('lets only an admin override a same-name match, with a reason', () => {
    const { unmount } = render(<Harness />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Addison Transportation' } })
    expect(screen.queryByRole('button', { name: /different company/ })).toBeNull()
    unmount()
    render(<Harness isAdmin />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Addison Transportation' } })
    fireEvent.click(screen.getByRole('button', { name: /different company/ }))
    fireEvent.change(screen.getByLabelText('Duplicate override reason'), { target: { value: 'Different company in Texas' } })
    expect(screen.getByTestId('blocked').textContent).toBe('false')
    expect(screen.getByTestId('override').textContent).toBe('Different company in Texas')
  })
})
