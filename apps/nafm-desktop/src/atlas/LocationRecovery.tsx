import type { MouseEventHandler } from "react";
import { CloseIcon, WarningIcon } from "../management/Icons";

interface LocationRecoveryProps {
  title: string;
  message: string;
  retrying: boolean;
  onRetry?: MouseEventHandler<HTMLButtonElement>;
  onDismiss: MouseEventHandler<HTMLButtonElement>;
}

export function LocationRecovery({ title, message, retrying, onRetry, onDismiss }: LocationRecoveryProps) {
  return (
    <div className="atlas-location-recovery">
      <div className="atlas-location-error" role="alert">
        <WarningIcon />
        <div>
          <strong>{title}</strong>
          <p>{message}</p>
        </div>
      </div>
      <div className="atlas-location-recovery-actions">
        {onRetry && (
          <button className="atlas-location-retry" type="button" aria-disabled={retrying || undefined}
            onClick={retrying ? undefined : onRetry}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
        <button className="atlas-location-dismiss" type="button" aria-label="Dismiss" title="Dismiss"
          aria-disabled={retrying || undefined} onClick={retrying ? undefined : onDismiss}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
