// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { tabletStackTable, tabletStackTables } from './phoneTables'

const TABLE = `
  <div class="tms-tablet-cards">
    <div id="host">
      <table>
        <thead><tr><th>Unit</th><th>VIN</th><th>Driver</th><th>Insurance</th><th>IFTA</th></tr></thead>
        <tbody><tr><td>3114</td><td>1FUJ…</td><td>Lee Lara</td><td>2027-01-01</td><td>2026-12-31</td></tr></tbody>
      </table>
    </div>
  </div>`

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

/** jsdom has no layout: give the host its room and the table its own width. */
function size(root: HTMLElement, room: number, natural: number): HTMLTableElement {
  const host = root.querySelector<HTMLElement>('#host')!
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => room })
  const table = root.querySelector('table')!
  table.getBoundingClientRect = () => ({ width: natural } as DOMRect)
  return table
}

afterEach(() => { document.body.innerHTML = '' })

describe('fleet tables on an iPad', () => {
  it('turns a table wider than its room into labelled cards', () => {
    const root = mount(TABLE)
    const table = size(root, 771, 1513)
    expect(tabletStackTables(root)).toBe(1)
    expect(table.dataset.tabletStack).toBe('on')
    expect(table.dataset.naturalWidth).toBe('1513')
    expect(table.tBodies[0].rows[0].cells[3].dataset.label).toBe('Insurance')
  })

  it('leaves a table that fits as a table', () => {
    const root = mount(TABLE)
    const table = size(root, 771, 771)
    expect(tabletStackTable(table)).toBe(false)
    expect(table.dataset.tabletStack).toBeUndefined()
  })

  it('brings the table back when the iPad turns to a width that fits', () => {
    const root = mount(TABLE)
    const table = size(root, 771, 1000)
    expect(tabletStackTable(table)).toBe(true)
    size(root, 1100, 1100)
    expect(tabletStackTable(table)).toBe(false)
    expect(table.dataset.tabletStack).toBeUndefined()
  })

  it('only touches tables on the fleet pages', () => {
    const root = mount(TABLE.replace('tms-tablet-cards', 'other-page'))
    size(root, 300, 1513)
    expect(tabletStackTables(root)).toBe(0)
  })
})
