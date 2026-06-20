import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

/**
 * App-level boundary so an unexpected render error shows a recoverable screen
 * instead of a blank page in production.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for monitoring; replace with a real logger when available.
    console.error("Unhandled UI error", error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="boundary-screen" role="alert">
          <div className="boundary-card">
            <h1>일시적인 오류가 발생했습니다</h1>
            <p>페이지를 다시 불러오면 대부분 해결됩니다. 문제가 계속되면 잠시 후 다시 방문해주세요.</p>
            <button type="button" onClick={this.handleReload}>
              새로고침
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
