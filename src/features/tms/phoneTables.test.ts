// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { MIN_COLUMNS, columnLabels, labelTable, labelTables, markPhoneSheets, watchPhoneTables } from './phoneTables'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

const WIDE = `
  <table id="t">
    <thead><tr><th>PRO</th><th>Customer</th><th colspan="2">Amounts</th><th></th></tr></thead>
    <tbody>
      <tr><td>20039</td><td>IGT LOGISTICS</td><td>$4,500.00</td><td>$2,250.00</td><td><button>Open</button></td></tr>
      <tr><td colspan="5">2 more loads</td></tr>
    </tbody>
    <tfoot><tr><td>Total</td><td></td><td>$4,500.00</td><td>$2,250.00</td><td></td></tr></tfoot>
  </table>`

afterEach(() => { document.body.innerHTML = '' })

describe('phone tables', () => {
  it('reads header labels and expands colspans', () => {
    const root = mount(WIDE)
    expect(columnLabels(root.querySelector('table')!)).toEqual(['PRO', 'Customer', 'Amounts', 'Amounts', ''])
  })

  it('labels body and foot cells and marks the table for stacking', () => {
    const root = mount(WIDE)
    const table = root.querySelector('table')!
    expect(labelTable(table)).toBe(true)
    expect(table.dataset.phoneStack).toBe('on')
    const cells = Array.from(table.tBodies[0].rows[0].cells)
    expect(cells.map((c) => c.dataset.label ?? null)).toEqual(['PRO', 'Customer', 'Amounts', 'Amounts', null])
    // A full-width row keeps the first column's label only.
    expect(table.tBodies[0].rows[1].cells[0].dataset.label).toBe('PRO')
    expect(table.tFoot!.rows[0].cells[2].dataset.label).toBe('Amounts')
  })

  it(`leaves tables with fewer than ${MIN_COLUMNS} headed columns alone`, () => {
    const root = mount('<table><thead><tr><th>Name</th><th>Amount</th></tr></thead><tbody><tr><td>a</td><td>$1</td></tr></tbody></table>')
    expect(labelTables(root)).toBe(0)
    expect(root.querySelector('table')!.dataset.phoneStack).toBeUndefined()
  })

  it('skips DenseGrid, screen-reader, opted-out and dashboard tables', () => {
    const head = '<thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></tbody>'
    const root = mount(`
      <table class="tms-dg-table">${head}</table>
      <table class="sr-only">${head}</table>
      <div data-phone-stack="off"><table>${head}</table></div>
      <div class="tms-phone-keep"><table>${head}</table></div>
      <table id="plain">${head}</table>`)
    expect(labelTables(root)).toBe(1)
    expect(root.querySelector<HTMLTableElement>('#plain')!.dataset.phoneStack).toBe('on')
  })

  it('labels rows added after it started watching', async () => {
    const root = mount(WIDE)
    const stop = watchPhoneTables(root)
    const body = root.querySelector('tbody')!
    const row = document.createElement('tr')
    row.innerHTML = '<td>20031</td><td>Schneider</td><td>$3,755.33</td><td>$1,877.67</td><td></td>'
    body.appendChild(row)
    await new Promise((r) => setTimeout(r, 30))
    expect(row.cells[2].dataset.label).toBe('Amounts')
    stop()
  })

  it('tags older dialogs and side sheets but not tms-dialog-content', () => {
    const root = mount(`
      <div class="tms-portal" role="dialog" id="d"></div>
      <div class="tms-portal h-full" role="dialog" id="s"></div>
      <div class="tms-portal tms-dialog-content" role="dialog" id="t"></div>`)
    markPhoneSheets(root)
    expect(root.querySelector<HTMLElement>('#d')!.dataset.phoneSheet).toBe('dialog')
    expect(root.querySelector<HTMLElement>('#s')!.dataset.phoneSheet).toBe('side')
    expect(root.querySelector<HTMLElement>('#t')!.dataset.phoneSheet).toBeUndefined()
  })
})
