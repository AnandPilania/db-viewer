import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/report-error";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it in the tree so one broken
 * component shows a recoverable error screen instead of a blank white page.
 * Doesn't catch errors in event handlers or async code — see
 * lib/report-error.ts's installGlobalErrorReporting() for those.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError(error.message, { stack: error.stack, componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
          <AlertTriangle size={32} className="text-destructive" />
          <div className="text-sm font-medium">Something went wrong</div>
          <div className="max-w-md text-xs text-muted-foreground">{this.state.error.message}</div>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
