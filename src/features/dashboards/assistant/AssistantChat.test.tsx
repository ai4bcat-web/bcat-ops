// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as api from '@/lib/apiClient'
import { AssistantChat } from './AssistantChat'
import { ASSISTANT_SUGGESTIONS } from './assistantCopy'

vi.mock('@/lib/apiClient', () => ({ askAssistant: vi.fn() }))

const reply = (over: Partial<Awaited<ReturnType<typeof api.askAssistant>>> = {}) =>
  ({ reply: 'Revenue is **$12,000**.', toolsUsed: ['run_query'], modelError: null, ms: 10, ...over })

beforeEach(() => vi.clearAllMocks())

describe('AssistantChat', () => {
  it('sends the whole transcript each turn and shows the answer with what was looked up', async () => {
    vi.mocked(api.askAssistant).mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply({ reply: 'Second answer', toolsUsed: [] }))
    render(<AssistantChat />)
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'revenue?' } })
    fireEvent.click(screen.getByRole('button', { name: /Ask$/ }))
    expect(await screen.findByText('$12,000')).toBeInTheDocument()
    expect(screen.getByText('Looked up business data')).toBeInTheDocument()
    expect(api.askAssistant).toHaveBeenLastCalledWith([{ role: 'user', text: 'revenue?' }])

    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'and profit?' } })
    fireEvent.click(screen.getByRole('button', { name: /Ask$/ }))
    expect(await screen.findByText('Second answer')).toBeInTheDocument()
    expect(api.askAssistant).toHaveBeenLastCalledWith([
      { role: 'user', text: 'revenue?' },
      { role: 'assistant', text: 'Revenue is **$12,000**.' },
      { role: 'user', text: 'and profit?' },
    ])
  })

  it('a suggestion chip asks that question', async () => {
    vi.mocked(api.askAssistant).mockResolvedValue(reply())
    render(<AssistantChat />)
    fireEvent.click(screen.getByRole('button', { name: ASSISTANT_SUGGESTIONS[0]! }))
    await waitFor(() => expect(api.askAssistant).toHaveBeenCalledWith([{ role: 'user', text: ASSISTANT_SUGGESTIONS[0] }]))
    expect(screen.queryByRole('button', { name: ASSISTANT_SUGGESTIONS[1]! })).toBeNull()
  })

  it('shows a model error with Retry that resends the same transcript', async () => {
    vi.mocked(api.askAssistant).mockResolvedValueOnce(reply({ reply: '', modelError: 'The assistant took too long to answer.' })).mockResolvedValueOnce(reply({ reply: 'Back now' }))
    render(<AssistantChat />)
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /Ask$/ }))
    expect(await screen.findByText(/took too long/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Back now')).toBeInTheDocument()
    expect(vi.mocked(api.askAssistant).mock.calls[1]![0]).toEqual([{ role: 'user', text: 'hi' }])
  })

  it('never renders a link from the model text', async () => {
    vi.mocked(api.askAssistant).mockResolvedValue(reply({ reply: 'See [here](https://evil.test) now' }))
    const { container } = render(<AssistantChat />)
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /Ask$/ }))
    await screen.findByText(/now/)
    expect(container.querySelector('a')).toBeNull()
  })

  it('Enter sends and Shift+Enter does not', async () => {
    vi.mocked(api.askAssistant).mockResolvedValue(reply())
    render(<AssistantChat />)
    const box = screen.getByLabelText('Ask a question')
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(api.askAssistant).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(api.askAssistant).toHaveBeenCalledTimes(1))
  })
})
