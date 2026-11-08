// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TmsDocumentFrame } from './TmsDocumentFrame'

describe('TmsDocumentFrame', () => {
  it('embeds a PDF in an iframe', () => {
    render(<TmsDocumentFrame url="https://x/y" fileKey="a/b.pdf" title="Policy" />)
    expect(screen.getByTitle('Policy').tagName).toBe('IFRAME')
  })

  it('shows an image for an image key', () => {
    render(<TmsDocumentFrame url="https://x/y" fileKey="a/b.jpg" title="Photo" />)
    expect(screen.getByAltText('Photo')).toBeInTheDocument()
  })

  it('says plainly when there is no file, and does not wait for a url', () => {
    render(<TmsDocumentFrame url={null} fileKey={null} title="t" />)
    expect(screen.getByText('This item has no file attached.')).toBeInTheDocument()
  })

  it('shows loading while the url is pending', () => {
    render(<TmsDocumentFrame url={null} fileKey="a/b.pdf" title="t" />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('names a fetch failure, and explains HEIC and unknown types', () => {
    const { rerender } = render(<TmsDocumentFrame url={null} fileKey="a/b.pdf" title="t" error="expired link" />)
    expect(screen.getByText(/Couldn't open this document: expired link/)).toBeInTheDocument()
    rerender(<TmsDocumentFrame url="u" fileKey="a/b.heic" title="t" />)
    expect(screen.getByText(/HEIC photo/)).toBeInTheDocument()
    rerender(<TmsDocumentFrame url="u" fileKey="a/b.xyz" title="t" />)
    expect(screen.getByText(/can't be previewed/)).toBeInTheDocument()
  })

  it('offers Download only when given a handler', () => {
    const onDownload = vi.fn()
    const { rerender } = render(<TmsDocumentFrame url="u" fileKey="a.pdf" title="t" />)
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    rerender(<TmsDocumentFrame url="u" fileKey="a.pdf" title="t" onDownload={onDownload} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(onDownload).toHaveBeenCalled()
  })
})
