// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_AUTOMATION_POLICY, type AutomationPolicyPatch } from '@/lib/trackingAutomation'
import { patchProblems, smsCount } from './policyPatch'
import { TrackingAutomationEditor } from './TrackingAutomationEditor'

const inherited = { ...DEFAULT_AUTOMATION_POLICY, checkCallsAuto: true }

function mount(scope: 'GLOBAL' | 'CUSTOMER', value: AutomationPolicyPatch) {
  const onChange = vi.fn()
  render(<TrackingAutomationEditor scope={scope} value={value} inherited={inherited} onChange={onChange} />)
  return onChange
}

describe('TrackingAutomationEditor', () => {
  it('shows the inherited value and emits a patch without the key when Inherit is re-ticked', () => {
    const onChange = mount('CUSTOMER', { checkCallsAuto: false, podAuto: true })
    const auto = screen.getByLabelText('Send check calls on the plan\'s schedule without anyone clicking') as HTMLInputElement
    expect(auto.checked).toBe(false)

    fireEvent.click(screen.getByLabelText('Inherit Automatic check calls'))
    expect(onChange).toHaveBeenCalledWith({ podAuto: true })
  })

  it('locks an inheriting field to the inherited value and writes it when Inherit is cleared', () => {
    const onChange = mount('CUSTOMER', {})
    const auto = screen.getByLabelText('Send check calls on the plan\'s schedule without anyone clicking') as HTMLInputElement
    expect(auto.checked).toBe(true)
    expect(auto.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('Inherit Automatic check calls'))
    expect(onChange).toHaveBeenCalledWith({ checkCallsAuto: true })
  })

  it('removes a template key when its Inherit is ticked and drops an emptied templates object', () => {
    const onChange = mount('CUSTOMER', { templates: { podSms: 'Need the POD' } })
    fireEvent.click(screen.getByLabelText('Inherit POD request — text message'))
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('inserts a clicked placeholder into the template', () => {
    const onChange = mount('GLOBAL', { templates: { checkCallSms: 'Where is ' } })
    const box = screen.getAllByPlaceholderText('Built-in wording')[0] as HTMLTextAreaElement
    box.setSelectionRange(9, 9)
    fireEvent.click(within0('{proNumber}'))
    expect(onChange).toHaveBeenCalledWith({ templates: { checkCallSms: 'Where is {proNumber}' } })
  })

  it('renders the preview with sample values and flags an unknown placeholder inline', () => {
    mount('GLOBAL', { templates: { checkCallSms: 'Update on {proNumber} {bogus}' } })
    const preview = screen.getByTestId('preview-checkCallSms').textContent ?? ''
    expect(preview).not.toContain('{proNumber}')
    expect(preview).toContain('{bogus}')
    expect(screen.getByText(/bogus/i, { selector: '.tms-field-error' })).toBeTruthy()
  })

  it('counts SMS segments of 160 and goes red past the 1600 ceiling', () => {
    expect(smsCount('x'.repeat(161))).toMatchObject({ segments: 2, tooLong: false })
    expect(smsCount('x'.repeat(1601)).tooLong).toBe(true)
    mount('GLOBAL', { templates: { podSms: 'x'.repeat(1601) } })
    expect(screen.getByTestId('sms-count-podSms').className).toContain('tms-field-error')
  })
})

function within0(label: string): HTMLElement {
  return screen.getAllByText(label)[0]
}

describe('patchProblems', () => {
  it('accepts an overnight quiet-hours window', () => {
    const quietHours = { enabled: true, start: '21:00', end: '06:00', timezone: 'America/Chicago', channels: ['SMS' as const] }
    expect(patchProblems({ quietHours }, DEFAULT_AUTOMATION_POLICY)).toEqual([])
  })

  it('rejects an unknown placeholder, a bad time and POD automation with no channel', () => {
    expect(patchProblems({ templates: { podSms: 'Hi {nope}' } }, DEFAULT_AUTOMATION_POLICY)).toHaveLength(1)
    const bad = { enabled: true, start: '25:00', end: '06:00', timezone: 'America/Chicago', channels: ['SMS' as const] }
    expect(patchProblems({ quietHours: bad }, DEFAULT_AUTOMATION_POLICY)).toHaveLength(1)
    expect(patchProblems({ podAuto: true, podChannels: [] }, DEFAULT_AUTOMATION_POLICY)).toHaveLength(1)
  })
})
