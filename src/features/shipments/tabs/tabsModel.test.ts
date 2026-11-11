import { describe, expect, it } from 'vitest'
import { MAX_SHIPMENT_TABS, addTab, neighbourAfterClose, parseTabs, removeTab, serializeTabs, setTabMeta, tabLabel } from './tabsModel'

describe('tabsModel', () => {
  it('opening a shipment adds a tab once; opening it again focuses it instead of duplicating', () => {
    let t = addTab([], 'a')
    t = addTab(t, 'b')
    t = addTab(t, 'a')
    expect(t.map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('later meta only fills what is blank, and setTabMeta replaces the label', () => {
    let t = addTab([], 'a', { number: '10793' })
    t = addTab(t, 'a', { number: 'IGNORED', customer: 'THE ROYAL GROUP' })
    expect(t[0]).toEqual({ id: 'a', number: '10793', customer: 'THE ROYAL GROUP' })
    expect(setTabMeta(t, 'a', { customer: 'ACME' })[0]!.customer).toBe('ACME')
  })
  it('labels read "PRO <number> · <customer>", and "Loading…" until the number is known', () => {
    expect(tabLabel({ id: 'a', number: '10793', customer: 'THE ROYAL GROUP' })).toBe('PRO 10793 · THE ROYAL GROUP')
    expect(tabLabel({ id: 'a', number: '10793', customer: null })).toBe('PRO 10793')
    expect(tabLabel({ id: 'a', number: null, customer: null })).toBe('Loading…')
  })
  it('closing a focused tab goes to its right neighbour, else its left, else the board', () => {
    const t = ['a', 'b', 'c'].reduce((acc, id) => addTab(acc, id), [] as ReturnType<typeof addTab>)
    expect(neighbourAfterClose(t, 'b')).toBe('c')
    expect(neighbourAfterClose(t, 'c')).toBe('b')
    expect(neighbourAfterClose(addTab([], 'a'), 'a')).toBeNull()
    expect(removeTab(t, 'b').map((x) => x.id)).toEqual(['a', 'c'])
  })
  it('never keeps more than the cap, dropping the oldest', () => {
    let t: ReturnType<typeof addTab> = []
    for (let i = 0; i < MAX_SHIPMENT_TABS + 3; i++) t = addTab(t, `s${i}`)
    expect(t).toHaveLength(MAX_SHIPMENT_TABS)
    expect(t[0]!.id).toBe('s3')
  })
  it('round-trips through sessionStorage text and survives garbage', () => {
    const t = addTab(addTab([], 'a', { number: '1', customer: 'X' }), 'b')
    expect(parseTabs(serializeTabs(t))).toEqual(t)
    expect(parseTabs('not json')).toEqual([])
    expect(parseTabs('{"a":1}')).toEqual([])
    expect(parseTabs('[{"id":"a"},{"id":"a"},{"nope":1}]').map((x) => x.id)).toEqual(['a'])
    expect(parseTabs(null)).toEqual([])
  })
})
