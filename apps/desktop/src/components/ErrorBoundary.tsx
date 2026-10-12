// Keeps one failing panel from blanking the whole app.
import { Component, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

export class ErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error(`[Space Bench] ${this.props.name} crashed`, error) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm font-medium">The {this.props.name} hit an error</div>
        <pre className="max-w-xl whitespace-pre-wrap rounded-lg bg-muted p-3 text-left font-mono text-xs text-destructive">{this.state.error.message}</pre>
        <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>Try again</Button>
      </div>
    )
  }
}
