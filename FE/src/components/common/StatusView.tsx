type LoadingViewProps = {
  label?: string;
};

export function LoadingView({ label = "데이터를 불러오는 중입니다" }: LoadingViewProps) {
  return (
    <div className="status-view" role="status" aria-live="polite">
      <span className="status-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

type ErrorViewProps = {
  message?: string;
  onRetry?: () => void;
};

export function ErrorView({
  message = "데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
  onRetry,
}: ErrorViewProps) {
  return (
    <div className="status-view status-view--error" role="alert">
      <strong>연결에 문제가 발생했습니다</strong>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
