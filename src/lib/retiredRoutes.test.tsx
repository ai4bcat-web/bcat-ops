// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ParamRedirect } from '@/components/ParamRedirect'
import { RETIRED_ROUTES } from './retiredRoutes'

function Where() {
  const { pathname, search } = useLocation()
  return <div data-testid="where">{pathname}{search}</div>
}

function visit(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        {RETIRED_ROUTES.map((r) => <Route key={r.path} path={r.path} element={<ParamRedirect to={r.to} />} />)}
        <Route path="/tms/rates" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('retired Lane rates page', () => {
  it('sends the old Lane rates URL (and the old /rates) to Quotes, keeping the query', () => {
    visit('/tms/rates/lanes?window=90')
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/rates?window=90')
  })

  it('sends the legacy /rates there too', () => {
    visit('/rates')
    expect(screen.getByTestId('where')).toHaveTextContent('/tms/rates')
  })
})
