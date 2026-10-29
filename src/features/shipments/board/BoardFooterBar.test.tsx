// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BoardFooterBar } from './BoardFooterBar'

function renderFooter(props: Partial<Parameters<typeof BoardFooterBar>[0]> = {}) {
  return render(
    <BoardFooterBar
      shown={50}
      total={69}
      secondsToRefresh={12}
      autoRefresh
      onToggleAutoRefresh={vi.fn()}
      onNext50={vi.fn()}
      onRefresh={vi.fn()}
      onExportCsv={vi.fn()}
      onShowMap={vi.fn()}
      onIconKey={vi.fn()}
      onNewTab={vi.fn()}
      onBatchTask={vi.fn()}
      onSplitScreen={vi.fn()}
      {...props}
    />
  )
}

describe('BoardFooterBar', () => {
  it('renders N of M', () => {
    renderFooter()
    expect(screen.getByText(/Records shown/i)).toHaveTextContent('50')
    expect(screen.getByText(/Records shown/i)).toHaveTextContent('69')
  })

  it('renders the countdown', () => {
    renderFooter({ secondsToRefresh: 7 })
    expect(screen.getByText(/Next refresh:/i)).toHaveTextContent('7s')
  })

  it('toggles auto refresh', () => {
    const onToggleAutoRefresh = vi.fn()
    renderFooter({ onToggleAutoRefresh, autoRefresh: true })
    fireEvent.click(screen.getByRole('button', { name: /Toggle auto refresh/i }))
    expect(onToggleAutoRefresh).toHaveBeenCalled()
  })

  it('raises every footer callback', () => {
    const handlers = {
      onNext50: vi.fn(),
      onRefresh: vi.fn(),
      onExportCsv: vi.fn(),
      onShowMap: vi.fn(),
      onIconKey: vi.fn(),
      onNewTab: vi.fn(),
      onBatchTask: vi.fn(),
      onSplitScreen: vi.fn(),
    }
    renderFooter({ selectedCount: 2, ...handlers })
    fireEvent.click(screen.getByRole('button', { name: /^Get next 50$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Export to CSV$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Show map$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Icon key$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^New tab$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Batch task$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Split screen$/i }))
    Object.values(handlers).forEach((fn) => expect(fn).toHaveBeenCalled())
  })

  it('disables batch task when nothing is selected', () => {
    renderFooter({ selectedCount: 0 })
    expect(screen.getByRole('button', { name: /Batch task/i })).toBeDisabled()
  })
})
