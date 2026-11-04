// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { LegacyBadge } from './LegacyBadge'

describe('LegacyBadge', () => {
  it('shows nothing for a shipment that is not flagged — only the import engine sets the flag', () => {
    const { container } = render(<LegacyBadge legacyImported={false} />)
    expect(container).toBeEmptyDOMElement()
    expect(render(<LegacyBadge />).container).toBeEmptyDOMElement()
  })

  it('says the documents live in the Aljex archive, and names the run in its tooltip', () => {
    render(<LegacyBadge legacyImported importRunId="aljexrun:01" importedAt="2026-11-03T12:00:00Z" />)
    const badge = screen.getByTestId('legacy-badge')
    expect(badge).toHaveTextContent('Legacy - documents in Aljex archive')
    expect(badge.getAttribute('title')).toMatch(/aljexrun:01/)
  })
})
