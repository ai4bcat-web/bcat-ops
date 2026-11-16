import { describe, expect, it } from 'vitest'
import { missingOnLoadIssues } from './validation'
import type { FormIssue } from './sectionProps'

const issue = (over: Partial<FormIssue>): FormIssue => ({ id: 'x', section: 'customer', fieldKey: 'f', label: 'L', message: 'm', severity: 'warn', ...over })

describe('missingOnLoadIssues', () => {
  const issues = [
    issue({ id: 'pickup:factor:PICKUP_ZIP', marked: true, label: 'Pick Up ZIP' }),
    issue({ id: 'customer:ref:po', severity: 'error', label: 'Customer ref (PO)' }),
    issue({ id: 'shipping:needs:weight', label: 'Weight' }),
  ]
  it('lists the factoring fields marked on a saved factored load, plus its PO', () => {
    expect(missingOnLoadIssues(issues, true, true).map((i) => i.label)).toEqual(['Pick Up ZIP', 'Customer ref (PO)'])
  })
  it('is empty on a new load or a customer that does not factor (the board shows no MISSING chip there)', () => {
    expect(missingOnLoadIssues(issues, false, true)).toEqual([])
    expect(missingOnLoadIssues(issues, true, false)).toEqual([])
  })
})
