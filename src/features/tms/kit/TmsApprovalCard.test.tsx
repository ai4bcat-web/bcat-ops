// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TmsApprovalCard } from './TmsApprovalCard'

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('TmsApprovalCard', () => {
  it('calls the matching handler once', () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    wrap(<TmsApprovalCard title="Offer" onApprove={onApprove} onReject={onReject} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('disables both while busy', () => {
    wrap(<TmsApprovalCard title="Offer" busy onApprove={() => {}} onReject={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
  })

  it('renders no buttons without handlers', () => {
    wrap(<TmsApprovalCard title="Offer" />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
