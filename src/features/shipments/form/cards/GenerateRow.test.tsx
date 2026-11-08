// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { GenerateRow } from './GenerateRow'
import type { FormCtx } from '../sectionProps'
import { makeCtx, savedBundle } from '../sections/ah5TestKit'

vi.mock('@/features/shipments/components/BolDialog', () => ({
  BolDialog: ({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) => (
    <div data-testid="bol-dialog"><button data-testid="bol-saved" onClick={onSaved} /><button data-testid="bol-close" onClick={onClose} /></div>
  ),
}))

const saved = (over: Partial<FormCtx> = {}, bundle = savedBundle()) =>
  makeCtx({ mode: 'edit', bundle: { ...bundle, shipment: { ...bundle.shipment, status: 'DRAFT' } } as never, ...over })
const withCarrier = () => savedBundle({ loadCarriers: [{ id: 'lc1', status: 'ACTIVE' }] })
const off = (id: string) => (screen.getByTestId(id) as HTMLButtonElement).disabled

function setup(ctx: FormCtx) {
  render(<GenerateRow ctx={ctx} />)
  return ctx
}

describe('GenerateRow', () => {
  it('create mode: everything off with the reason', () => {
    setup(makeCtx())
    for (const id of ['bol', 'ratecon', 'info']) expect(off(`card-documents-generate-${id}`)).toBe(true)
    expect(screen.getByTestId('card-documents-generate-bol').title).toBe('Create the shipment first')
  })

  it('a saved DRAFT with no carrier can generate a BOL; Rate Con and Send Info wait for a carrier', () => {
    setup(saved())
    expect(off('card-documents-generate-bol')).toBe(false)
    expect(off('card-documents-generate-ratecon')).toBe(true)
    expect(screen.getByTestId('card-documents-generate-info').title).toBe('Cover a carrier first')
  })

  it('a dirty form says Save first and disables all three', () => {
    setup(saved({ dirty: true }, withCarrier()))
    for (const id of ['bol', 'ratecon', 'info']) expect(off(`card-documents-generate-${id}`)).toBe(true)
    expect(screen.getByTestId('card-documents-generate-hint').textContent).toBe('Save first')
  })

  it('a voided or canceled shipment cannot generate', () => {
    setup(saved({ locked: { fields: {}, stops: {}, voided: true } }))
    expect(off('card-documents-generate-bol')).toBe(true)
  })

  it('Rate Con / Send Info call the existing actions; Generate BOL opens the dialog and a save refreshes the bundle', () => {
    const ctx = setup(saved({}, withCarrier()))
    fireEvent.click(screen.getByTestId('card-documents-generate-ratecon'))
    fireEvent.click(screen.getByTestId('card-documents-generate-info'))
    expect(ctx.actions.openSendRateCon).toHaveBeenCalledTimes(1)
    expect(ctx.actions.openSendInfo).toHaveBeenCalledTimes(1)
    const refresh = vi.fn(async () => {})
    ctx.refreshBundle = refresh
    fireEvent.click(screen.getByTestId('card-documents-generate-bol'))
    fireEvent.click(screen.getByTestId('bol-saved'))
    expect(refresh).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('bol-close'))
    expect(screen.queryByTestId('bol-dialog')).toBeNull()
  })
})
