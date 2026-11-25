import { useCallback, useState, type RefObject } from "react";
import { RefreshIcon } from "../management/Icons";
import type { ScanSite, SiteScanAction } from "./siteVerification";

interface VerificationScanButtonProps {
  action: SiteScanAction;
  onScanSite: ScanSite;
  onScanError?: (message: string | null) => void;
  focusTarget?: RefObject<HTMLElement | null>;
  className: string;
  compact?: boolean;
  describedBy?: string;
}

export function VerificationScanButton({ action, onScanSite, onScanError, focusTarget, className, compact, describedBy }: VerificationScanButtonProps) {
  const [starting, setStarting] = useState(false);
  const trackFocus = useCallback((button: HTMLButtonElement | null) => {
    if (!button || !focusTarget) return;
    return () => {
      if (document.activeElement !== button) return;
      const fallback = focusTarget.current;
      // Keep focus in the current surface when the completed action is removed.
      queueMicrotask(() => {
        if (fallback?.isConnected && document.activeElement === document.body) fallback.focus({ preventScroll: true });
      });
    };
  }, [focusTarget]);
  const disabled = action.disabled || starting;
  const showStarting = starting && !action.disabled;
  const label = showStarting ? action.startingLabel : action.label;
  const shortLabel = showStarting ? action.startingShortLabel : action.shortLabel;

  return (
    <button
      ref={trackFocus} className={className} type="button"
      aria-label={label} aria-disabled={disabled || undefined} aria-describedby={describedBy}
      onClick={async (event) => {
        if (disabled) return;
        event.currentTarget.focus({ preventScroll: true });
        onScanError?.(null);
        setStarting(true);
        try {
          await onScanSite(action.siteId, onScanError);
        } finally {
          setStarting(false);
        }
      }}
    >
      <RefreshIcon />
      {compact ? (
        <>
          <span className="atlas-coverage-action-full">{label}</span>
          <span className="atlas-coverage-action-short">{shortLabel}</span>
        </>
      ) : label}
    </button>
  );
}
