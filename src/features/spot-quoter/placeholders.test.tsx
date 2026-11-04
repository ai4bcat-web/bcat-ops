// @vitest-environment jsdom
/**
 * The four slots Step AA reserves for Step AB render a labelled placeholder with no
 * controls, so the routes and the nav rows never land on a blank page before AB ships.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SpotInboxPage } from './SpotInboxPage'
import { SpotCallbackPage } from './SpotCallbackPage'
import { FollowUpsPage } from '@/features/directory/FollowUpsPage'
import { SpotQuoterSettingsPage } from '@/features/tms/settings/SpotQuoterSettingsPage'

describe('Step AB placeholders', () => {
  it.each([
    ['Spot inbox', SpotInboxPage],
    ['Spot inbox callback', SpotCallbackPage],
    ['Follow-ups', FollowUpsPage],
    ['Spot quoter settings', SpotQuoterSettingsPage],
  ])('%s says it arrives with Step AB and offers no controls', (_name, Page) => {
    render(<Page />)
    expect(screen.getByText('Arrives with Step AB')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
