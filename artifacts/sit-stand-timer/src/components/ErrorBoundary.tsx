import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      const message = err.message || String(err);
      const stack = err.stack ?? "";
      const componentStack = this.state.componentStack ?? "";
      const details = [
        `Message: ${message}`,
        "",
        "Stack:",
        stack,
        "",
        "Component stack:",
        componentStack,
      ].join("\n");

      const copyDetails = () => {
        try {
          void navigator.clipboard?.writeText(details);
        } catch {
          /* ignore */
        }
      };

      const hardReload = () => {
        try {
          localStorage.removeItem("sit-stand-timer-state-v1");
        } catch {
          /* ignore */
        }
        this.setState({ error: null, componentStack: null });
        window.location.reload();
      };

      return (
        <div className="min-h-screen flex flex-col items-center justify-start bg-background px-6 pt-12 pb-8 text-center gap-4 overflow-y-auto">
          <div className="text-5xl">⚠️</div>
          <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
          <p className="text-sm text-muted-foreground max-w-xs">
            The timer ran into an unexpected problem. Your session data is safe.
          </p>

          <div className="w-full max-w-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-3 text-left">
            <div className="text-xs font-mono font-semibold text-red-700 dark:text-red-300 break-all">
              {message}
            </div>
            {stack ? (
              <pre className="mt-2 text-[10px] font-mono text-red-600/80 dark:text-red-400/80 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {stack}
              </pre>
            ) : null}
            {componentStack ? (
              <pre className="mt-2 text-[10px] font-mono text-red-600/60 dark:text-red-400/60 whitespace-pre-wrap break-all max-h-32 overflow-y-auto border-t border-red-200 dark:border-red-900 pt-2">
                {componentStack}
              </pre>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 w-full max-w-sm">
            <button
              onClick={() => { this.setState({ error: null, componentStack: null }); window.location.reload(); }}
              className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Reload app
            </button>
            <button
              onClick={hardReload}
              className="px-5 py-2.5 rounded-xl bg-amber-600 text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Clear cached timer state & reload
            </button>
            <button
              onClick={copyDetails}
              className="px-5 py-2.5 rounded-xl bg-muted text-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Copy error details
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
