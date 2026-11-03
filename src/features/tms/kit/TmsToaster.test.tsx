// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TmsToaster } from './TmsToaster'

const toasterProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }))
vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toasterProps.last = props
    return null
  },
}))

describe('TmsToaster', () => {
  it('uses the themed card look on /tms routes', () => {
    render(<MemoryRouter initialEntries={['/tms/dashboard']}><TmsToaster /></MemoryRouter>)
    expect(toasterProps.last?.className).toContain('tms-portal')
    expect(toasterProps.last?.richColors).toBe(false)
  })

  it('leaves the driver PWA toaster untouched on /driver routes', () => {
    render(<MemoryRouter initialEntries={['/driver/home']}><TmsToaster /></MemoryRouter>)
    expect(toasterProps.last?.className).toBeUndefined()
    expect(toasterProps.last?.richColors).toBe(true)
  })
})
