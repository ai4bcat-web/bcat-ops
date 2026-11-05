// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type {
  DashboardAccess,
  DashChatInput,
  DashChatResult,
  DashOptions,
  DashRunResult,
  DashboardSpec,
} from '@/lib/dashboards/types'

const api = vi.hoisted(() => ({
  dashboardChat: vi.fn(),
  dashboardPreview: vi.fn(),
  dashboardOptions: vi.fn(),
  saveDashboard: vi.fn(),
  getDashboard: vi.fn(),
}))
vi.mock('@/lib/apiClient', () => api)

const accessState = vi.hoisted(() => ({ value: null as unknown as DashboardAccess }))
vi.mock('../viewer/useDashboardAccess', () => ({ useDashboardAccess: () => accessState.value }))

// The grid itself is AI4's; the builder only owes it the spec, the results and the loading flag.
vi.mock('../viewer/WidgetGrid', () => ({
  WidgetGrid: (p: { spec: DashboardSpec; results: unknown[] | null; loading: boolean }) => (
    <div data-testid="grid" data-loading={String(p.loading)}>
      {p.spec.title}|{p.spec.widgets.length}|{p.results ? p.results.length : 'none'}
    </div>
  ),
}))

import { DashboardBuilderPage } from './DashboardBuilderPage'

const OPTIONS: DashOptions = {
  access: { create: true, publishCompany: false, viewAll: false },
  divisions: [],
  staff: [{ id: 'u1', name: 'Rae Rep', teamKeys: [] }],
  teams: [{ key: 'EAST', name: 'East' }],
  catalog: [],
  limits: { maxWidgets: 12, maxSpecBytes: 32000, maxMessages: 20 },
  visibility: { viewAll: false, ownedCustomers: 2, teamKeys: [] },
}

function specOf(title: string, widgets = 1): DashboardSpec {
  return {
    v: 1,
    title,
    scope: { kind: 'ME' },
    filters: { window: { preset: 'THIS_QUARTER' }, divisions: [], customerIds: [], repIds: [], modes: [] },
    widgets: Array.from({ length: widgets }, (_, i) => ({
      id: `w${i + 1}`,
      type: 'BAR' as const,
      title: 'Revenue',
      size: 'L' as const,
      query: { id: 'fin.byGroup' as const, params: { metric: 'revenue', groupBy: 'CUSTOMER', limit: 12 } },
    })),
  }
}

const RUN: DashRunResult = {
  results: [],
  resolved: { from: '2026-10-01', to: '2026-12-31', months: [] },
  visibility: { viewAll: false, ownedCustomers: 2, teamKeys: [] },
  asOf: '2026-11-04T00:00:00.000Z',
  ms: 5,
}

function chatResult(over: Partial<DashChatResult>): DashChatResult {
  return {
    reply: '',
    questions: [],
    spec: null,
    issues: [],
    resolved: { divisions: [], customers: [], reps: [], unresolved: [] },
    modelMs: 1,
    modelError: null,
    ...over,
  }
}

const SCOPE_Q = { id: 'scope', kind: 'SCOPE' as const, text: 'Is this dashboard for the whole company, or for specific users/teams?', choices: [] }

function mount(path = '/tms/dashboard/new') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/tms/dashboard" element={<div>HOME</div>} />
        <Route path="/tms/dashboard/d/:id" element={<div>VIEWED</div>} />
        <Route path="/tms/dashboard/new" element={<DashboardBuilderPage />} />
        <Route path="/tms/dashboard/d/:id/edit" element={<DashboardBuilderPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function say(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } })
  await act(async () => {
    fireEvent.click(screen.getByTestId('dash-send'))
  })
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  accessState.value = { create: true, publishCompany: false, viewAll: false }
  api.dashboardOptions.mockResolvedValue(OPTIONS)
  api.dashboardPreview.mockResolvedValue(RUN)
})

describe('builder access', () => {
  it('bounces a user without the create permission to the dashboard home', async () => {
    accessState.value = { create: false, publishCompany: false, viewAll: false }
    mount()
    expect(await screen.findByText('HOME')).toBeInTheDocument()
    expect(api.dashboardChat).not.toHaveBeenCalled()
  })

  it('shows the not-a-security-boundary banner to a non-viewAll builder only', async () => {
    mount()
    expect(await screen.findByTestId('dash-d1-banner')).toHaveTextContent(/not a security boundary/i)
    cleanup()
    accessState.value = { create: true, publishCompany: true, viewAll: true }
    api.dashboardOptions.mockResolvedValue({ ...OPTIONS, access: { create: true, publishCompany: true, viewAll: true } })
    mount()
    await screen.findByLabelText('Message')
    expect(screen.queryByTestId('dash-d1-banner')).toBeNull()
  })
})

describe('chat flow', () => {
  it('asks the scope question, draws nothing until a chip is picked, then previews and iterates', async () => {
    api.dashboardChat
      .mockResolvedValueOnce(chatResult({ reply: 'Who is it for?', questions: [SCOPE_Q] }))
      .mockResolvedValueOnce(chatResult({ reply: 'Here it is.', spec: specOf('Revenue by customer') }))
      .mockResolvedValueOnce(chatResult({ reply: 'Monthly now.', spec: specOf('Revenue by customer, monthly', 2) }))
    mount()
    await say('revenue by customer this quarter')

    const q = await screen.findByTestId('dash-scope-question')
    expect(within(q).getByText(SCOPE_Q.text)).toBeInTheDocument()
    const first = api.dashboardChat.mock.calls[0][0] as DashChatInput
    expect(first.scope).toBeNull()
    expect(first.draft).toBeNull()
    expect(api.dashboardPreview).not.toHaveBeenCalled()
    expect(screen.queryByTestId('grid')).toBeNull()

    fireEvent.click(within(q).getByTestId('dash-scope-ME'))
    await waitFor(() => expect(api.dashboardPreview).toHaveBeenCalledTimes(1))
    const second = api.dashboardChat.mock.calls[1][0] as DashChatInput
    expect(second.scope).toEqual({ kind: 'ME' })
    expect(second.messages[second.messages.length - 1].role).toBe('user')
    expect(api.dashboardPreview.mock.calls[0][0]).toEqual({ spec: specOf('Revenue by customer') })
    expect(await screen.findByTestId('grid')).toHaveTextContent('Revenue by customer|1|0')
    expect(screen.queryByTestId('dash-scope-question')).toBeNull()

    await say('make the chart monthly')
    await waitFor(() => expect(api.dashboardPreview).toHaveBeenCalledTimes(2))
    const third = api.dashboardChat.mock.calls[2][0] as DashChatInput
    expect(third.draft?.title).toBe('Revenue by customer')
    expect(third.scope).toEqual({ kind: 'ME' })
    expect(await screen.findByText(/monthly\|2/)).toBeInTheDocument()
  })

  it('keeps Whole company disabled with the permission hint when publishCompany is missing', async () => {
    api.dashboardChat.mockResolvedValueOnce(chatResult({ reply: 'Who?', questions: [SCOPE_Q] }))
    mount()
    await say('anything')
    const chip = await screen.findByTestId('dash-scope-COMPANY')
    expect(chip).toBeDisabled()
    expect(chip).toHaveAttribute('title', 'Needs the Publish company dashboards permission')
    fireEvent.click(chip)
    expect(api.dashboardChat).toHaveBeenCalledTimes(1)
  })

  it('sends a specific-users scope only after the selection is applied', async () => {
    api.dashboardChat
      .mockResolvedValueOnce(chatResult({ reply: 'Who?', questions: [SCOPE_Q] }))
      .mockResolvedValueOnce(chatResult({ reply: 'ok', spec: specOf('T') }))
    mount()
    await say('x')
    fireEvent.click(await screen.findByTestId('dash-scope-USERS'))
    expect(api.dashboardChat).toHaveBeenCalledTimes(1)
    const apply = screen.getByRole('button', { name: 'Use selection' })
    expect(apply).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: 'Rae Rep' }))
    fireEvent.click(apply)
    await waitFor(() => expect(api.dashboardChat).toHaveBeenCalledTimes(2))
    expect((api.dashboardChat.mock.calls[1][0] as DashChatInput).scope).toEqual({ kind: 'USERS', userIds: ['u1'] })
  })

  it('cannot double-submit while a turn is pending', async () => {
    let release: (r: DashChatResult) => void = () => undefined
    api.dashboardChat.mockReturnValueOnce(new Promise<DashChatResult>((r) => (release = r)))
    mount()
    await say('first')
    expect(await screen.findByRole('status')).toHaveTextContent('Thinking')
    expect(screen.getByTestId('dash-send')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'second' } })
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter' })
    expect(api.dashboardChat).toHaveBeenCalledTimes(1)
    await act(async () => release(chatResult({ reply: 'ok', questions: [SCOPE_Q] })))
    await screen.findByTestId('dash-scope-question')
  })

  it('shows Model unavailable with Retry, keeps the transcript and resends the same request', async () => {
    api.dashboardChat
      .mockResolvedValueOnce(chatResult({ reply: 'Unavailable.', modelError: 'credit balance too low', questions: [SCOPE_Q] }))
      .mockResolvedValueOnce(chatResult({ reply: 'Back.', questions: [SCOPE_Q] }))
    mount()
    await say('revenue please')
    const err = await screen.findByTestId('dash-model-error')
    expect(err).toHaveTextContent('Model unavailable: credit balance too low')
    expect(screen.getByText('revenue please')).toBeInTheDocument()
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }))
    await screen.findByText('Back.')
    expect(api.dashboardChat.mock.calls[1][0]).toEqual(api.dashboardChat.mock.calls[0][0])
    expect(screen.queryByTestId('dash-model-error')).toBeNull()
    expect(screen.getAllByText('revenue please')).toHaveLength(1)
  })

  it('shows a transport failure with Retry and recovers', async () => {
    api.dashboardChat.mockRejectedValueOnce(new Error('Forbidden: creating dashboards needs the Create dashboards permission'))
    api.dashboardChat.mockResolvedValueOnce(chatResult({ reply: 'fine', questions: [SCOPE_Q] }))
    mount()
    await say('hello')
    expect(await screen.findByText(/Forbidden: creating dashboards/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('fine')
  })
})

describe('save', () => {
  it('saves the edited title with the scope and share list, then opens the dashboard', async () => {
    api.dashboardChat
      .mockResolvedValueOnce(chatResult({ reply: 'Who?', questions: [SCOPE_Q] }))
      .mockResolvedValueOnce(chatResult({ reply: 'ok', spec: specOf('Draft title') }))
    api.saveDashboard.mockResolvedValue({ id: 'd-9' })
    mount()
    await say('x')
    fireEvent.click(await screen.findByTestId('dash-scope-TEAM'))
    fireEvent.click(await screen.findByRole('button', { name: 'East' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use selection' }))
    await screen.findByTestId('grid')

    fireEvent.click(screen.getByTestId('dash-save'))
    const title = await screen.findByTestId('dash-save-title')
    fireEvent.change(title, { target: { value: 'East revenue' } })
    fireEvent.click(screen.getByTestId('dash-save-confirm'))

    expect(await screen.findByText('VIEWED')).toBeInTheDocument()
    const saved = api.saveDashboard.mock.calls[0][0]
    expect(saved.id).toBeUndefined()
    expect(saved.spec.title).toBe('East revenue')
    expect(saved.spec.scope).toEqual({ kind: 'TEAM', teamKeys: ['EAST'] })
    expect(saved.sharedWith).toEqual({ userIds: [], teamKeys: ['EAST'] })
  })

  it('keeps the dialog open and shows the server refusal when saving fails', async () => {
    api.dashboardChat
      .mockResolvedValueOnce(chatResult({ reply: 'Who?', questions: [SCOPE_Q] }))
      .mockResolvedValueOnce(chatResult({ reply: 'ok', spec: specOf('T') }))
    api.saveDashboard.mockRejectedValue(new Error('Conflict: dashboard changed; reload'))
    mount()
    await say('x')
    fireEvent.click(await screen.findByTestId('dash-scope-ME'))
    await screen.findByTestId('grid')
    fireEvent.click(screen.getByTestId('dash-save'))
    fireEvent.click(await screen.findByTestId('dash-save-confirm'))
    expect(await screen.findByText('Conflict: dashboard changed; reload')).toBeInTheDocument()
    expect(screen.getByTestId('dash-save-confirm')).toBeEnabled()
  })
})

describe('edit', () => {
  it('loads a saved dashboard into the preview and saves with its id and version', async () => {
    api.getDashboard.mockResolvedValue({
      canEdit: true,
      dashboard: { id: 'd-1', title: 'Mine', version: 4, spec: specOf('Mine') },
    })
    api.saveDashboard.mockResolvedValue({ id: 'd-1' })
    mount('/tms/dashboard/d/d-1/edit')
    await screen.findByTestId('grid')
    fireEvent.click(screen.getByTestId('dash-save'))
    fireEvent.click(await screen.findByTestId('dash-save-confirm'))
    await screen.findByText('VIEWED')
    expect(api.saveDashboard.mock.calls[0][0]).toMatchObject({ id: 'd-1', expectedVersion: 4 })
  })

  it('does not offer the builder for a dashboard the user cannot edit', async () => {
    api.getDashboard.mockResolvedValue({ canEdit: false, dashboard: { id: 'd-1', title: 'Theirs', version: 1, spec: specOf('Theirs') } })
    mount('/tms/dashboard/d/d-1/edit')
    expect(await screen.findByText(/not edit it/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).toBeNull()
  })
})
