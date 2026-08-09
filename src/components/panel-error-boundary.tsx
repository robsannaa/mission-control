"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { notifyError } from "@/lib/notification-store";

type Props = {
  children: ReactNode;
  section?: string;
};

type State = {
  hasError: boolean;
  error: Error | null;
  retryKey: number;
};

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[PanelErrorBoundary] ${this.props.section ?? "unknown"} crashed:`,
      error,
      info.componentStack,
    );
    notifyError(
      `${this.props.section ?? "A section"} crashed`,
      error.message,
      this.props.section,
    );
  }

  handleRetry = () => {
    this.setState((s) => ({
      hasError: false,
      error: null,
      retryKey: s.retryKey + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      const label = this.props.section ?? "This section";
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg">
            <AlertTriangle className="h-6 w-6 text-danger-fg" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Something went wrong
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {label} encountered an unexpected error.
            </p>
          </div>
          {this.state.error && (
            <pre className="max-h-32 max-w-md overflow-y-auto rounded-md bg-muted px-4 py-2 text-left text-xs text-fg-secondary dark:text-fg-subtle">
              {this.state.error.message}
            </pre>
          )}
          <button
            type="button"
            onClick={this.handleRetry}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/88"
          >
            <RotateCcw className="h-4 w-4" />
            Retry
          </button>
        </div>
      );
    }

    return <div key={this.state.retryKey} className="flex min-h-0 min-w-0 flex-1 flex-col">{this.props.children}</div>;
  }
}
