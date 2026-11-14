import { describe, it, expect } from 'vitest'
import { shipmentEditorPath } from './shipmentLinks'

describe('shipmentEditorPath', () => {
  it("is the shipments board's PRO-link target: the tabbed editor, not the read-only page", () => {
    expect(shipmentEditorPath('shp-1')).toBe('/tms/shipments/shp-1/edit')
    expect(shipmentEditorPath('a b')).toBe('/tms/shipments/a%20b/edit')
  })
})
