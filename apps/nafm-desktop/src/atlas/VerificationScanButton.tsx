import { useCallback, type RefObject } from "react";
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
  siteName?: string;
}

export function VerificationScanButton({
  action, onScanSite, onScanError, focusTarget, className, compact, describedBy, siteName,
}: VerificationScanButtonProps) {
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
  const { disabled, label, shortLabel } = action;
  const accessibleLabel = !siteName ? label : label === "Scan this site"
    ? `Scan ${siteName}` : `${label.replace(/…$/, "")} for ${siteName}`;

  return (
    <button
      ref={trackFocus} className={className} type="button"
      aria-label={accessibleLabel} aria-disabled={disabled || undefined} aria-describedby={describedBy}
      onClick={(event) => {
        if (disabled) return;
        event.currentTarget.focus({ preventScroll: true });
        onScanError?.(null);
        void onScanSite(action.siteId, onScanError);
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
