/**
 * A page that fails to render shows what went wrong and a way back, never a blank screen.
 *
 * Two causes look alike to a person: a real render error, and a page chunk that no longer exists because the app was
 * deployed while this tab was open. The second is cured by one reload, so it reloads once on its own (guarded, so a chunk
 * that is really gone cannot loop) and otherwise offers the button.
 */
import { Component } from 'react'
import type { ReactNode } from 'react'
import { TmsButton } from '@/features/tms/kit'
import { isChunkLoadError, reloadForStaleChunk } from '@/lib/staleChunk'

interface Props { children: ReactNode; /** A new value clears a shown error (the route changing). */ resetKey?: string }
interface State { error: Error | null }

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[PageErrorBoundary]', error)
    if (isChunkLoadError(error)) reloadForStaleChunk()
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const stale = isChunkLoadError(error)
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" data-testid="page-error">
        <div className="text-lg font-semibold">{stale ? 'BCAT Ops was updated' : 'This page could not be shown'}</div>
        <p className="tms-muted max-w-md text-sm">
          {stale
            ? 'A newer version was released while this page was open. Reload to get it. Anything you saved is kept.'
            : 'Your work was saved if you pressed Save. Reload the page; if it comes back, tell Ryne what you clicked.'}
        </p>
        {!stale && <pre className="max-w-2xl overflow-auto whitespace-pre-wrap rounded-md border p-3 text-left text-xs">{error.message}</pre>}
        <TmsButton variant="primary" onClick={() => window.location.reload()}>Reload</TmsButton>
      </div>
    )
  }
}
