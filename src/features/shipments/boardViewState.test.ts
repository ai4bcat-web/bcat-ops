// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { boardListKey, boardViewKey, clearBoardView, readBoardView, writeBoardView } from './boardViewState'

describe('board view state', () => {
  beforeEach(() => window.localStorage.clear())

  it('keys by user, pane and list, so two people never share filters', () => {
    expect(boardViewKey('sub-a', 'left', 'active')).not.toBe(boardViewKey('sub-b', 'left', 'active'))
    expect(boardViewKey('sub-a', 'left', 'active')).not.toBe(boardViewKey('sub-a', 'left', 'all'))
    expect(boardListKey('sub-a')).not.toBe(boardListKey('sub-b'))
  })

  it('restores what was left (filters, flags, search, scroll, last opened) and clears it', () => {
    const key = boardViewKey('sub-a', 'left', 'active')
    writeBoardView(key, {
      filters: { status: { values: ['PAST DELIVERY DATE'] } },
      flags: ['docsMissing'],
      query: '149',
      pageSize: 200,
      scrollTop: 640,
      lastOpenedId: 'shp-1',
    })
    expect(readBoardView(key)).toEqual({
      filters: { status: { values: ['PAST DELIVERY DATE'] } },
      flags: ['docsMissing'],
      query: '149',
      pageSize: 200,
      scrollTop: 640,
      lastOpenedId: 'shp-1',
    })
    expect(readBoardView(boardViewKey('sub-b', 'left', 'active'))).toEqual({})
    clearBoardView(key)
    expect(readBoardView(key)).toEqual({})
  })

  it('ignores a corrupt entry', () => {
    window.localStorage.setItem(boardViewKey('sub-a', 'left', 'active'), '{not json')
    expect(readBoardView(boardViewKey('sub-a', 'left', 'active'))).toEqual({})
  })
})
