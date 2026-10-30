// @vitest-environment jsdom
/**
 * The Academy renders the real `Docs/academy` folder, so these tests are also the check
 * that the bundle picks those files up at all: an index with no articles, or an article
 * route that cannot find its slug, is how this page fails in production.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AcademyPage } from './AcademyPage'

import type * as ApiClient from '@/lib/apiClient'

const askAcademy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/apiClient', async () => {
  const actual = await vi.importActual<typeof ApiClient>('@/lib/apiClient')
  return { ...actual, askAcademy }
})

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tms/academy" element={<AcademyPage />} />
        <Route path="/tms/academy/:slug" element={<AcademyPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AcademyPage', () => {
  it('lists the shipped articles, linked by slug, with the BETA tag', () => {
    at('/tms/academy')
    expect(screen.getByText('BETA')).toBeTruthy()
    const commissions = screen.getByRole('link', { name: 'Commissions' })
    expect(commissions.getAttribute('href')).toBe('/tms/academy/commissions')
    expect(screen.getByRole('link', { name: 'Reports' })).toBeTruthy()
    // The folder's README is an index of the folder, not an article.
    expect(screen.queryByRole('link', { name: /BCAT Ops Academy/i })).toBeNull()
  })

  it('renders the Ask assistant panel', () => {
    at('/tms/academy')
    expect(screen.getByText('Ask the Academy')).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy()
    expect(screen.queryByText(/arrives in Step M/i)).toBeNull()
  })

  it('asks a question and renders the cited answer', async () => {
    askAcademy.mockResolvedValue({ answer: 'Use the release gate.', citations: ['release-to-accounting'] })
    at('/tms/academy')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'How do I invoice a load?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(screen.getByText('Use the release gate.')).toBeTruthy())
    const citation = screen.getByRole('link', { name: 'release-to-accounting' })
    expect(citation.getAttribute('href')).toBe('/tms/academy/release-to-accounting')
  })

  it('renders one article from its slug', () => {
    at('/tms/academy/commissions')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Commissions')
    expect(screen.getByText(/pay nobody from here/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'All articles' }).getAttribute('href')).toBe('/tms/academy')
  })

  it('says so when the slug is not an article', () => {
    at('/tms/academy/not-a-real-article')
    expect(screen.getByText(/not in the Academy/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Back to the Academy/i })).toBeTruthy()
  })
})
