// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { markEmptyControls } from './useRequiredEmptyMarks'

describe('markEmptyControls', () => {
  it('flags empty and filled controls, skips checkboxes', () => {
    document.body.innerHTML = '<div><input id="a" value=""/><input id="b" value="x"/><input id="c" type="checkbox"/><select id="d"><option value="">-</option></select></div>'
    markEmptyControls(document.body)
    expect(document.getElementById('a')!.dataset.empty).toBe('true')
    expect(document.getElementById('b')!.dataset.empty).toBe('false')
    expect(document.getElementById('c')!.dataset.empty).toBeUndefined()
    expect(document.getElementById('d')!.dataset.empty).toBe('true')
  })
})
