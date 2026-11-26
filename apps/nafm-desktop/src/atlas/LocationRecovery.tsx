import type { MouseEventHandler } from "react";
import { CloseIcon, WarningIcon } from "../management/Icons";

export interface LocationOpeningProps {
  message: string;
  announce: boolean;
  onCancel?: MouseEventHandler<HTMLButtonElement>;
}

export function LocationOpening({ message, announce, onCancel }: LocationOpeningProps) {
  return (
    <div className="atlas-folder-opening">
      <span role={announce ? "status" : undefined}>{message}</span>
      {onCancel && (
        <button type="button" onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }} onClick={onCancel}>
          Cancel opening
        </button>
      )}
    </div>
  );
}

interface LocationRecoveryProps {
  title: string;
  message: string;
  retrying: boolean;
  retryDisabled?: boolean;
  onRetry?: MouseEventHandler<HTMLButtonElement>;
  onDismiss: MouseEventHandler<HTMLButtonElement>;
}

export function LocationRecovery({ title, message, retrying, retryDisabled, onRetry, onDismiss }: LocationRecoveryProps) {
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
          <button className="atlas-location-retry" type="button" aria-disabled={retrying || retryDisabled || undefined}
            onClick={retrying || retryDisabled ? undefined : onRetry}>
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
