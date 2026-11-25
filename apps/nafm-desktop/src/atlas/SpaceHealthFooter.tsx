import { useRef, type ReactNode } from "react";
import type { SiteVerification } from "./siteVerification";
import { VerificationScanButton } from "./VerificationScanButton";
import "./space-health-footer.css";

interface SpaceHealthFooterProps {
  verification: SiteVerification;
  onScanSite: (siteId: string) => Promise<void>;
  children?: ReactNode;
}

export function SpaceHealthFooter({ verification, onScanSite, children }: SpaceHealthFooterProps) {
  const section = useRef<HTMLElement>(null);
  const quietlyVerified = verification.tone === "ready" && verification.status === "Verified";

  return (
    <section className="atlas-space-health-footer" aria-label="Space health" ref={section} tabIndex={-1}>
      <div className={quietlyVerified ? "atlas-space-health-verification atlas-scan-announcement" : "atlas-space-health-verification"}>
        <div className="atlas-space-health-status" role="status">
          <strong>Site verification</strong>
          <span data-tone={verification.tone}>{verification.status}</span>
        </div>
        {verification.action && (
          <VerificationScanButton
            action={verification.action} onScanSite={onScanSite} focusTarget={section}
            className="atlas-space-health-action"
          />
        )}
      </div>
      {children}
    </section>
  );
}
