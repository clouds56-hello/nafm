import { useCallback, useId, useLayoutEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import type { HealthPresentation } from "../lib/health";
import type { SiteOverview } from "../lib/types";
import { PlusIcon } from "../management/Icons";
import { revealInCompactAtlas } from "./compactAtlasScroll";
import { CoverageScanActions } from "./CoverageScanActions";
import type { SiteVerification } from "./siteVerification";
import "./coverage-footer.css";

interface CoverageFooterProps {
  source: SiteOverview;
  target: SiteOverview | null;
  targets: readonly SiteOverview[];
  coverage: HealthPresentation | null;
  hasFolderContent: boolean;
  sourceVerification: SiteVerification;
  targetVerification: SiteVerification | null;
  navigationBusy?: boolean;
  navigationProgress?: string;
  announceProgress?: boolean;
  onTargetChange: (id: string) => void;
  onSwap: () => void;
  onScanSite: (siteId: string) => Promise<void>;
  onAddSite?: MouseEventHandler<HTMLButtonElement>;
  addedTarget?: { id: string; opener: HTMLButtonElement };
  children?: ReactNode;
}

function comparisonResult(
  target: SiteOverview | null,
  coverage: HealthPresentation | null,
  hasFolderContent: boolean,
) {
  if (!target || !hasFolderContent) return { text: "Coverage unavailable", tone: "unavailable" };
  if (coverage?.state === "exact") return { text: "Coverage ready", tone: "ready" };
  if (coverage?.state === "partial") return { text: "Estimated coverage", tone: "estimate" };
  return { text: "Coverage unavailable", tone: "unavailable" };
}

function unavailableReason(
  source: SiteVerification,
  target: SiteVerification,
  hasFolderContent: boolean,
) {
  if (!hasFolderContent && source.tone === "ready") return "No content in this folder to compare.";
  if (source.needsVerification && target.needsVerification) return "Both sites need verification.";
  if (source.needsVerification) return "Source verification is pending.";
  if (target.needsVerification) return "Target verification is pending.";
  return hasFolderContent ? "Verified inventories can’t be compared." : null;
}

export function CoverageFooter({
  source, target, targets, coverage, hasFolderContent, sourceVerification, targetVerification, navigationBusy,
  navigationProgress, announceProgress = true, onTargetChange, onSwap, onScanSite, onAddSite, addedTarget, children,
}: CoverageFooterProps) {
  const sourceStatusId = useId();
  const targetStatusId = useId();
  const targetPicker = useRef<HTMLSelectElement>(null);
  const removedAddFocus = useRef<HTMLButtonElement | null>(null);
  const addButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      removedAddFocus.current = document.activeElement === button ? button : null;
    };
  }, []);

  useLayoutEffect(() => {
    if (!addedTarget || !targets.some((site) => site.id === addedTarget.id)) return;
    const { opener } = addedTarget;
    const focus = document.activeElement;
    // The new target's picker replaces Add site when the dashboard publishes the new row.
    const replaceFocus = focus === opener || (focus === document.body && removedAddFocus.current === opener);
    removedAddFocus.current = null;
    if (!replaceFocus) return;
    revealInCompactAtlas(targetPicker.current);
    targetPicker.current?.focus({ preventScroll: true });
  }, [addedTarget, targets]);

  const result = comparisonResult(target, coverage, hasFolderContent);
  const reason = !navigationBusy && target && targetVerification && result.tone === "unavailable"
    ? unavailableReason(sourceVerification, targetVerification, hasFolderContent) : null;

  return (
    <section className="atlas-coverage-footer" aria-label="Coverage comparison">
      <div className="atlas-coverage-main">
        <div className="atlas-coverage-pair" role="group" aria-label="Comparison direction">
          <div className="atlas-coverage-site">
            <strong title={source.name} aria-describedby={sourceStatusId}>{source.name}</strong>
            <small id={sourceStatusId} data-tone={sourceVerification.tone} title={sourceVerification.status}>{sourceVerification.status}</small>
          </div>
          <svg className="atlas-coverage-arrow" width="17" height="17" viewBox="0 0 18 18" fill="none"
            stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          >
            <path d="M3 9h12m-4-4 4 4-4 4" />
          </svg>
          <div className="atlas-coverage-site">
            {targets.length > 0 ? (
              <select
                ref={targetPicker}
                value={target?.id ?? ""}
                aria-label="Comparison target"
                aria-describedby={targetVerification ? targetStatusId : undefined}
                title={target?.name ?? "Choose a comparison target"}
                onChange={(event) => onTargetChange(event.currentTarget.value)}
              >
                {!target && <option value="" disabled>Choose a site</option>}
                {targets.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
              </select>
            ) : <span className="atlas-coverage-no-target">No comparison target</span>}
            {targetVerification && (
              <small id={targetStatusId} data-tone={targetVerification.tone} title={targetVerification.status}>{targetVerification.status}</small>
            )}
          </div>
        </div>
        {target && (
          <button
            className="atlas-coverage-swap" type="button" aria-label="Swap source and target" title="Swap source and target"
            aria-disabled={navigationBusy || undefined} onClick={navigationBusy ? undefined : (event) => {
              event.currentTarget.focus({ preventScroll: true });
              onSwap();
            }}
          >
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none"
              stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <path d="M3.5 6.5h13m-3.5-3.5 3.5 3.5-3.5 3.5M16.5 13.5h-13m3.5-3.5-3.5 3.5L7 17" />
            </svg>
          </button>
        )}
      </div>
      <div className="atlas-coverage-info">
        <div className="atlas-coverage-status" role={navigationBusy && !announceProgress ? undefined : "status"}>
          <span data-tone={navigationBusy ? "active" : result.tone}>
            {navigationBusy ? navigationProgress ?? "Updating comparison…" : result.text}
          </span>
          {reason && <span>{reason}</span>}
        </div>
        {target && (
          <CoverageScanActions actions={[sourceVerification.action, targetVerification?.action]}
            onScanSite={onScanSite} focusTarget={targetPicker} className="atlas-coverage-actions"
            buttonClassName="atlas-coverage-action" compact />
        )}
        {!targets.length && onAddSite && (
          <button ref={addButtonRef} className="atlas-coverage-action" type="button" aria-haspopup="dialog" onClick={onAddSite}>
            <PlusIcon /> Add site
          </button>
        )}
        {children}
      </div>
    </section>
  );
}
