import { useCallback, useState, type RefObject } from "react";
import { RefreshIcon } from "../management/Icons";
import type { CoverageScanAction } from "./coverageVerification";

interface ScanButtonOptions {
  onScanSite: (siteId: string) => Promise<void>;
  focusTarget: RefObject<HTMLSelectElement | null>;
  buttonClassName: string;
  compact?: boolean;
}

function CoverageScanButton({ action, onScanSite, focusTarget, buttonClassName, compact }: ScanButtonOptions & { action: CoverageScanAction }) {
  const [starting, setStarting] = useState(false);
  const trackFocus = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (document.activeElement !== button) return;
      const picker = focusTarget.current;
      // Move focus after the completed action leaves the DOM, if the comparison is still open.
      queueMicrotask(() => {
        if (picker?.isConnected && document.activeElement === document.body) picker.focus({ preventScroll: true });
      });
    };
  }, [focusTarget]);
  const disabled = action.disabled || starting;
  const label = starting && !action.disabled ? `Starting ${action.role} scan…` : action.label;
  const shortLabel = starting && !action.disabled ? `Starting ${action.role}…` : action.shortLabel;

  return (
    <button
      ref={trackFocus} className={buttonClassName} type="button"
      aria-label={label} aria-disabled={disabled || undefined}
      onClick={async (event) => {
        if (disabled) return;
        event.currentTarget.focus({ preventScroll: true });
        setStarting(true);
        try {
          await onScanSite(action.siteId);
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

export function CoverageScanActions({ actions, className, ...options }: ScanButtonOptions & {
  actions: readonly (CoverageScanAction | undefined)[];
  className?: string;
}) {
  const available = actions.filter((action) => action !== undefined);
  if (available.length === 0) return null;
  return (
    <div className={className}>
      {available.map((action) => <CoverageScanButton key={action.siteId} action={action} {...options} />)}
    </div>
  );
}
