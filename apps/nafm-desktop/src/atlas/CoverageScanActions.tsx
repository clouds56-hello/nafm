import type { RefObject } from "react";
import type { SiteScanAction } from "./siteVerification";
import { VerificationScanButton } from "./VerificationScanButton";

export function CoverageScanActions({ actions, className, buttonClassName, ...options }: {
  actions: readonly (SiteScanAction | undefined)[];
  onScanSite: (siteId: string) => Promise<void>;
  focusTarget: RefObject<HTMLSelectElement | null>;
  className?: string;
  buttonClassName: string;
  compact?: boolean;
}) {
  const available = actions.filter((action) => action !== undefined);
  if (available.length === 0) return null;
  return (
    <div className={className}>
      {available.map((action) => <VerificationScanButton key={action.siteId} action={action} className={buttonClassName} {...options} />)}
    </div>
  );
}
