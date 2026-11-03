// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { TmsAlert } from './TmsAlert'

describe('TmsAlert', () => {
  it.each([['red', 'alert'], ['orange', 'alert'], ['green', 'status'], ['blue', 'status']] as const)('%s tone announces as %s', (tone, role) => {
    render(<TmsAlert tone={tone}>msg</TmsAlert>)
    expect(screen.getByRole(role)).toHaveTextContent('msg')
  })

  it('an explicit role wins', () => {
    render(<TmsAlert tone="red" role="status">msg</TmsAlert>)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
