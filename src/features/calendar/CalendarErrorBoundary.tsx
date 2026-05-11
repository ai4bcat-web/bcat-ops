import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class CalendarErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-red-600 font-semibold text-lg">Calendar failed to load</div>
          <pre className="text-xs text-left bg-muted p-4 rounded-md max-w-2xl overflow-auto text-destructive whitespace-pre-wrap border border-border">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            className="px-4 py-2 bg-foreground text-background rounded-md text-sm font-medium"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
