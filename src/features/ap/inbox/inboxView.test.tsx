// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TmsTable } from '@/features/tms/kit'
import type { ApInboxItemRecord } from '@/lib/apInbox/types'
import { inboxItem } from './inboxTestkit'
import { inboxView } from './inboxView'

function draw(rows: ApInboxItemRecord[], handlers: Partial<Parameters<typeof inboxView>[0]> = {}) {
  const v = inboxView({
    banner: null, rows, loading: false, busy: false,
    onLink: vi.fn(), onCreate: vi.fn(), onDismiss: vi.fn(), onUndo: vi.fn(), onOpenFile: vi.fn(), ...handlers,
  })
  return render(<TmsTable columns={v.columns} rows={v.rows} rowKey={v.rowKey} />)
}

describe('the AP inbox queue rows', () => {
  it('offers link / create / dismiss on a queued item and wires each to the item', () => {
    const onLink = vi.fn()
    const onDismiss = vi.fn()
    const item = inboxItem()
    draw([item], { onLink, onDismiss })
    fireEvent.click(screen.getByTestId(`ap-inbox-link-${item.id}`))
    fireEvent.click(screen.getByTestId(`ap-inbox-dismiss-${item.id}`))
    expect(onLink).toHaveBeenCalledWith(item)
    expect(onDismiss).toHaveBeenCalledWith(item)
    expect(screen.getByText('Open in Gmail').getAttribute('href')).toBe(item.sourceUrl)
  })

  it('does not offer to create a bill from a credit memo', () => {
    const item = inboxItem({ kind: 'CREDIT_MEMO', reviewReason: 'CREDIT' })
    draw([item])
    expect(screen.getByTestId(`ap-inbox-create-${item.id}`)).toBeDisabled()
  })

  it('the why lists each signal with points and shows a veto in plain words', () => {
    const item = inboxItem({ reviewReason: 'REMIT_MISMATCH' })
    item.match!.top!.vetoes = ['REMIT_MISMATCH']
    draw([item])
    const why = screen.getByTestId(`ap-inbox-why-${item.id}`)
    expect(why).toHaveTextContent('PRO number matches +0.60')
    expect(why).toHaveTextContent('Remit-to differs from the carrier on file — verify by phone before paying.')
  })

  it('an auto-updated row shows Undo, disabled with the reason when nothing was written', () => {
    const applied = { at: 'x', by: 'ap-inbox', mode: 'AUTO' as const, before: { billNumber: null }, after: { billNumber: 'INV-5521' }, fields: ['billNumber'] }
    const done = inboxItem({ id: 'a', status: 'APPLIED', applied })
    const empty = inboxItem({ id: 'b', status: 'APPLIED', applied: { ...applied, fields: [] } })
    draw([done, empty])
    expect(screen.getByTestId('ap-inbox-undo-a')).toBeEnabled()
    expect(screen.getByTestId('ap-inbox-undo-b')).toBeDisabled()
    expect(screen.queryByTestId('ap-inbox-link-a')).toBeNull()
  })
})
