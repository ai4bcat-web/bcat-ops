// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { FinancialLines } from './components/FinancialLines'
import type { ChargeCodeDef, LoadChargeRecord, PricingDefaults } from '@/types/tms'

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

const catalog: ChargeCodeDef[] = [
  { code: 'LINEHAUL', label: 'Linehaul', calculatedBy: 'FLAT' },
  { code: 'FSC', label: 'Fuel surcharge', calculatedBy: 'PER_MILE' },
  { code: 'DETENTION', label: 'Detention', calculatedBy: 'FLAT' },
]

function charge(patch: Partial<LoadChargeRecord> & Pick<LoadChargeRecord, 'side' | 'code' | 'rateCents' | 'isRate' | 'sortOrder'>): LoadChargeRecord {
  return {
    id: `${patch.side}-${patch.code}`,
    shipmentId: 'shp-1',
    calculatedBy: 'FLAT',
    amountCents: 0,
    createdBy: 'a@b.c',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

// Sell 2000.00 linehaul + 150.00 detention; buy 1600.00 linehaul.
const charges: LoadChargeRecord[] = [
  charge({ side: 'CUSTOMER', code: 'LINEHAUL', rateCents: 200000, isRate: true, sortOrder: 0 }),
  charge({ side: 'CUSTOMER', code: 'DETENTION', rateCents: 15000, isRate: false, sortOrder: 1 }),
  charge({ side: 'CARRIER', code: 'LINEHAUL', rateCents: 160000, isRate: true, sortOrder: 0 }),
]

const pricing: PricingDefaults = { mode: 'MARGIN', defaultBps: 2000 }

function totals() {
  return within(screen.getByTestId('financial-totals'))
}

function renderGrid(props: Partial<React.ComponentProps<typeof FinancialLines>> = {}) {
  const onSave = vi.fn(async () => {})
  render(
    <FinancialLines
      charges={charges}
      catalog={catalog}
      context={{ miles: 500 }}
      pricing={pricing}
      marginFloorBps={1000}
      onSave={onSave}
      {...props}
    />,
  )
  return onSave
}

describe('FinancialLines totals', () => {
  it('separates the rate lines from the full revenue and cost', () => {
    renderGrid()
    const box = totals()
    // Customer Rate = linehaul only; Revenue = linehaul + detention.
    expect(box.getByText('$2000.00')).toBeTruthy()
    expect(box.getByText('$2150.00')).toBeTruthy()
    // Carrier Rate and Cost are both the single buy line.
    expect(box.getAllByText('$1600.00')).toHaveLength(2)
  })

  it('shows profit and margin against revenue, not against the rate', () => {
    renderGrid()
    const box = totals()
    expect(box.getByText('$550.00')).toBeTruthy()
    expect(box.getByText('25.58%')).toBeTruthy()
  })

  it('reports a zero margin rather than a divide-by-zero on an empty shipment', () => {
    renderGrid({ charges: [] })
    expect(totals().getByText('0.00%')).toBeTruthy()
  })

  it('warns when the carrier cost is above top spend', () => {
    // Floor 10% of 2,150.00 → top spend 1,935.00; a 2,000.00 buy breaks it.
    renderGrid({ charges: [...charges, charge({ side: 'CARRIER', code: 'DETENTION', rateCents: 40000, isRate: false, sortOrder: 1 })] })
    expect(screen.getByText(/Carrier cost exceeds top spend/)).toBeTruthy()
  })

  it('stays quiet while the cost is inside top spend', () => {
    renderGrid()
    expect(screen.queryByText(/Carrier cost exceeds top spend/)).toBeNull()
  })

  it('reprices a line as it is edited, before anything is saved', async () => {
    renderGrid()
    fireEvent.change(screen.getByLabelText('CUSTOMER count 1'), { target: { value: '2' } })
    await waitFor(() => expect(totals().getByText('$4150.00')).toBeTruthy())
  })
})

const onSaveSpy = vi.fn(async () => {})

describe('FinancialLines editing', () => {
  it('leaves out a line nobody filled in instead of refusing the save', async () => {
    const onSave = renderGrid()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add line' })[1])
    await waitFor(() => expect(screen.getByText('1 empty line is left out when you save.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const sent = (onSave.mock.calls as unknown as [Array<{ side: string; code: string }>][])[0][0]
    expect(sent.map((l) => `${l.side}:${l.code}`)).toEqual(['CUSTOMER:LINEHAUL', 'CUSTOMER:DETENTION', 'CARRIER:LINEHAUL'])
  })

  it('refuses a line that has a rate but no charge code, and says which one', async () => {
    const onSave = renderGrid()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add line' })[1])
    await waitFor(() => expect(screen.getByLabelText('CARRIER charge code 2')).toBeTruthy())
    const rate = screen.getAllByLabelText('Rate').at(-1) as HTMLInputElement
    fireEvent.change(rate, { target: { value: '100.00' } })
    fireEvent.blur(rate)
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))

    await waitFor(() => expect(screen.getByText('Pick a charge code for the $100.00 carrier line, or remove it.')).toBeTruthy())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('drops a coded line worth nothing only where the caller asks for it', async () => {
    const withZero = [...charges, charge({ side: 'CARRIER', code: 'DETENTION', rateCents: 0, isRate: false, sortOrder: 1 })]
    for (const [dropZeroLines, expected] of [[false, 4], [true, 3]] as const) {
      const { unmount } = render(
        <FinancialLines charges={withZero} catalog={catalog} context={{ miles: 500 }} pricing={pricing} marginFloorBps={1000}
          dropZeroLines={dropZeroLines} onSave={onSaveSpy} />,
      )
      fireEvent.change(screen.getByLabelText('CUSTOMER count 1'), { target: { value: '2' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))
      await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1))
      expect((onSaveSpy.mock.calls as unknown as [unknown[]][])[0][0]).toHaveLength(expected)
      onSaveSpy.mockClear()
      unmount()
    }
  })

  it('holds Save, with the reason in words, until the caller says it can go', () => {
    renderGrid({ saveBlocked: 'Add the reason for the change to save.', beforeSave: <p>reason box</p> })
    fireEvent.change(screen.getByLabelText('CUSTOMER count 1'), { target: { value: '2' } })
    expect(screen.getByText('reason box')).toBeTruthy()
    expect(screen.getByText('Add the reason for the change to save.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save charges' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a negative count', async () => {
    const onSave = renderGrid()
    fireEvent.change(screen.getByLabelText('CARRIER count 1'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))

    await waitFor(() => expect(screen.getByText('A count cannot be negative.')).toBeTruthy())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('sends every line of both sides on save', async () => {
    const onSave = renderGrid()
    fireEvent.change(screen.getByLabelText('CUSTOMER count 1'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save charges' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const sent = onSave.mock.calls[0][0] as { side: string; code: string; count?: number | null }[]
    expect(sent).toHaveLength(3)
    expect(sent.find((l) => l.side === 'CUSTOMER' && l.code === 'LINEHAUL')?.count).toBe(2)
    expect(sent.filter((l) => l.side === 'CARRIER')).toHaveLength(1)
  })

  it('offers no inputs once the charges are frozen', () => {
    renderGrid({ readOnly: true })
    expect(screen.queryByRole('button', { name: 'Save charges' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull()
    expect((screen.getByLabelText('CUSTOMER count 1') as HTMLInputElement).disabled).toBe(true)
  })
})
