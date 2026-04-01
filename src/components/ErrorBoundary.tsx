import { Component, type ReactNode } from 'react'
import { useT } from '../i18n'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  retryCount: number
}

const MAX_RETRIES = 3

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, retryCount: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <ErrorFallback
          error={this.state.error}
          retryCount={this.state.retryCount}
          onReset={() => this.setState(prev => ({
            hasError: false,
            error: null,
            retryCount: prev.retryCount + 1,
          }))}
        />
      )
    }
    return this.props.children
  }
}

function ErrorFallback({ error, retryCount, onReset }: { error: Error | null; retryCount: number; onReset: () => void }) {
  const t = useT()
  const canRetry = retryCount < MAX_RETRIES

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="max-w-md">
        <div className="text-lg font-medium text-charcoal mb-2">
          {t.error?.title || 'Something went wrong'}
        </div>
        <p className="text-sm text-text-tertiary mb-4">
          {canRetry
            ? (error?.message || t.error?.description || 'An unexpected error occurred.')
            : (t.error?.persistentError || 'This error persists. Try restarting the app.')}
        </p>
        {canRetry ? (
          <button onClick={onReset} className="btn-primary text-sm">
            {t.error?.tryAgain || 'Try Again'}
          </button>
        ) : (
          <button
            onClick={() => window.location.reload()}
            className="btn-primary text-sm"
          >
            {t.error?.reload || 'Reload App'}
          </button>
        )}
      </div>
    </div>
  )
}
