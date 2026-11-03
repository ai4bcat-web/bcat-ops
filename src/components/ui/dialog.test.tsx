// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog'

describe('ui/dialog', () => {
  // Radix portals into <body>, outside .tms-shell: the content carries `tms-portal` itself,
  // which is what every legacy dialog's theming depends on.
  it('renders its content under the tms-portal scope', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog', { name: 'Edit' })).toHaveClass('tms-portal')
  })
})
