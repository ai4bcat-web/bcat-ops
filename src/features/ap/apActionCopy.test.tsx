// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AP_ACTION_COPY, apActionHelpRows } from './apActionCopy'
import { ApActionHelp } from './components/ApActionHelp'

/** Ryne 2026-11-18: "make it more clear what pay, remove, and unapprove all mean". Words only. */
describe('Payable action wording', () => {
  it('names each button for what it does, and says what it does not do', () => {
    expect(AP_ACTION_COPY.recordPayment.label).toBe('Record payment')
    expect(AP_ACTION_COPY.recordPayment.hint).toMatch(/does not send money/i)
    expect(AP_ACTION_COPY.backToAging.label).toBe('Back to Aging')
    expect(AP_ACTION_COPY.backToAging.hint).toMatch(/nothing is deleted or unapproved/i)
  })

  it('lists only the buttons the tab has', () => {
    expect(apActionHelpRows('selected').map((r) => r.label)).toEqual(['Record payment', 'Back to Aging'])
    expect(apActionHelpRows('aging').map((r) => r.label)).toEqual(['Move to Selected', 'Record payment'])
  })

  it('shows the help list behind "What do these do?"', () => {
    render(<ApActionHelp mode="selected" />)
    expect(screen.getByText('What do these do?')).toBeTruthy()
    expect(screen.getByText(/It does not send any money/)).toBeTruthy()
    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy()
  })
})
