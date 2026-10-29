// @vitest-environment jsdom
/**
 * The Academy renders the real `Docs/academy` folder, so these tests are also the check
 * that the bundle picks those files up at all: an index with no articles, or an article
 * route that cannot find its slug, is how this page fails in production.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AcademyPage } from './AcademyPage'
import { WorkflowsPage } from './WorkflowsPage'

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tms/academy" element={<AcademyPage />} />
        <Route path="/tms/academy/:slug" element={<AcademyPage />} />
        <Route path="/tms/workflows" element={<WorkflowsPage />} />
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

  it('says the assistant is still to come rather than offering a dead Ask box', () => {
    at('/tms/academy')
    expect(screen.getByText(/arrives in Step M/i)).toBeTruthy()
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

describe('WorkflowsPage', () => {
  it('is honest that nothing is configured yet and points at the Academy', () => {
    at('/tms/workflows')
    expect(screen.getByText(/Step K of the TMS/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Read the Academy/i }).getAttribute('href')).toBe('/tms/academy')
  })
})
