// @vitest-environment jsdom
/**
 * Picking a file did nothing. The screen came back with no page added and Done stayed grey.
 *
 * `input.files` is a LIVE FileList bound to the element, not a snapshot. The handler read
 * it into a variable and then set `value = ''` — which is what makes picking the same file
 * twice fire onChange again — and that clears the list the variable points at. By the time
 * anything looked, it was empty.
 *
 * Every existing test passed through this, because `fireEvent.change(input, {target:{files}})`
 * assigns a plain array that has nothing to do with the input's value. So this one models
 * the real thing: a FileList that empties when the input is cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PagePicker } from './PagePicker'

vi.mock('./imagePrep', () => ({
  prepareFile: vi.fn(async (file: File) => ({
    fileName: file.name, contentType: file.type, byteSize: file.size, blob: file,
  })),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

beforeEach(() => {
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => undefined
})

/**
 * Attach files the way a browser does: a list the element owns, which clearing `value`
 * empties. Without this the test cannot see the bug.
 */
function pickLikeABrowser(input: HTMLInputElement, files: File[]) {
  let current = [...files]
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => ({
      get length() { return current.length },
      item: (i: number) => current[i] ?? null,
      [Symbol.iterator]: function* () { yield* current },
    }),
  })
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => descriptor.get!.call(input),
    // The browser behaviour the handler tripped over.
    set: (v: string) => { if (v === '') current = []; descriptor.set!.call(input, v) },
  })
  fireEvent.change(input)
}

describe('picking a file', () => {
  it('keeps the pages even though the input is cleared in the same breath', async () => {
    render(<PagePicker onDone={vi.fn()} />)
    const input = screen.getByTestId('library-input') as HTMLInputElement

    pickLikeABrowser(input, [new File(['x'], 'pod.jpg', { type: 'image/jpeg' })])

    expect(await screen.findByText('1 page ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Done/ })).not.toBeDisabled()
  })

  it('keeps every page of a multi-page pick', async () => {
    render(<PagePicker onDone={vi.fn()} />)
    const input = screen.getByTestId('library-input') as HTMLInputElement

    pickLikeABrowser(input, [
      new File(['a'], 'p1.jpg', { type: 'image/jpeg' }),
      new File(['b'], 'p2.jpg', { type: 'image/jpeg' }),
      new File(['c'], 'p3.jpg', { type: 'image/jpeg' }),
    ])

    expect(await screen.findByText('3 pages ready')).toBeInTheDocument()
  })

  it('still clears the input, so the same file can be picked twice', async () => {
    // The reason the clear is there at all. Losing it would break re-picking one page.
    render(<PagePicker onDone={vi.fn()} />)
    const input = screen.getByTestId('library-input') as HTMLInputElement

    pickLikeABrowser(input, [new File(['x'], 'same.jpg', { type: 'image/jpeg' })])
    await screen.findByText('1 page ready')
    expect(input.value).toBe('')

    pickLikeABrowser(input, [new File(['x'], 'same.jpg', { type: 'image/jpeg' })])
    await waitFor(() => expect(screen.getByText('2 pages ready')).toBeInTheDocument())
  })
})
