// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AP_ACTION_COPY, GATES_HEADER, GATES_HELP, apActionHelpRows } from './apActionCopy'
import { ApActionHelp } from './components/ApActionHelp'

/** Ryne 2026-11-18: "make it more clear what pay, remove, and unapprove all mean". Words only. */
describe('Payable action wording', () => {
  it('names each button for what it does, and says what it does not do', () => {
    expect(AP_ACTION_COPY.recordPayment.label).toBe('Record payment')
    expect(AP_ACTION_COPY.recordPayment.hint).toMatch(/does not send money/i)
    expect(AP_ACTION_COPY.backToAging.label).toBe('Back to Aging')
    expect(AP_ACTION_COPY.backToAging.hint).toMatch(/nothing is deleted or unapproved/i)
    expect(AP_ACTION_COPY.sendBackToReview.label).toBe('Send back to review')
    expect(AP_ACTION_COPY.sendBackToReview.hint).toMatch(/approved again/i)
  })

  it('lists only the buttons the tab has', () => {
    expect(apActionHelpRows('selected').map((r) => r.label)).toEqual(['Record payment', 'Back to Aging', 'Send back to review'])
    expect(apActionHelpRows('aging').map((r) => r.label)).toEqual(['Move to Selected', 'Record payment', 'Send back to review', "What's blocking approval"])
  })

  it('shows the help list behind "What do these do?"', () => {
    render(<ApActionHelp mode="selected" />)
    expect(screen.getByText('What do these do?')).toBeTruthy()
    expect(screen.getByText(/It does not send any money/)).toBeTruthy()
    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy()
    expect(screen.getByText(/needs approving again/)).toBeTruthy()
  })

  it('calls the gates column what it is, with the help text on the header', () => {
    expect(GATES_HEADER).toBe("WHAT'S BLOCKING APPROVAL")
    expect(GATES_HELP).toMatch(/Only for bills In review/)
    expect(GATES_HELP).toMatch(/does not stop approval/)
    expect(GATES_HELP).toMatch(/Nothing — ready to approve/)
  })
})
