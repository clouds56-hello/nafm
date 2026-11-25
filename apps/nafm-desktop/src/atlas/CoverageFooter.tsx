import { useCallback, useId, useLayoutEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import { siteAnalysisReady } from "../lib/analysis";
import { formatCount } from "../lib/format";
import type { HealthPresentation } from "../lib/health";
import { scanPhaseLabel } from "../lib/scanView";
import type { ScanProgressView, SiteOverview } from "../lib/types";
import { PlusIcon, RefreshIcon } from "../management/Icons";
import { revealInCompactAtlas } from "./compactAtlasScroll";
import "./coverage-footer.css";

interface CoverageFooterProps {
  source: SiteOverview;
  target: SiteOverview | null;
  targets: readonly SiteOverview[];
  coverage: HealthPresentation | null;
  hasFolderContent: boolean;
  sourceScan?: ScanProgressView;
  targetScan?: ScanProgressView;
  navigationBusy?: boolean;
  canScanTarget: boolean;
  onTargetChange: (id: string) => void;
  onSwap: () => void;
  onScanTarget: () => void;
  onAddSite?: MouseEventHandler<HTMLButtonElement>;
  addedTarget?: { id: string; opener: HTMLButtonElement };
  children?: ReactNode;
}

function readiness(site: SiteOverview, progress?: ScanProgressView) {
  const phase = site.scan_state;
  if (phase === "cancelling") return { text: "Stopping scan", tone: "active" };
  if (phase === "queued") return { text: "Scan queued", tone: "active" };
  if (progress) {
    const label = scanPhaseLabel(progress.phase);
    const count = progress.phase === "hashing" && progress.total_files
      ? ` · ${formatCount(progress.processed_files)}/${formatCount(progress.total_files)}`
      : "";
    return { text: label + count, tone: "active" };
  }
  if (phase === "discovering" || phase === "publishing_metadata" || phase === "hashing" || phase === "finalizing") {
    return { text: scanPhaseLabel(phase), tone: "active" };
  }
  if (phase === "failed") return { text: "Scan failed", tone: "pending" };
  if (siteAnalysisReady(site)) {
    return { text: site.connection_state === "offline" ? "Verified · offline" : "Verified", tone: "ready" };
  }
  if (site.connection_state === "offline") return { text: "Offline", tone: "pending" };
  if (site.pending_hash_count > 0) {
    const noun = site.pending_hash_count === 1 ? "hash" : "hashes";
    return { text: `${formatCount(site.pending_hash_count)} ${noun} pending`, tone: "pending" };
  }
  return { text: site.hash_status === "unscanned" ? "Not scanned" : "Verification pending", tone: "pending" };
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

export function CoverageFooter({
  source, target, targets, coverage, hasFolderContent, sourceScan, targetScan, navigationBusy,
  canScanTarget, onTargetChange, onSwap, onScanTarget, onAddSite, addedTarget, children,
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

  const sourceStatus = readiness(source, sourceScan);
  const targetStatus = target ? readiness(target, targetScan) : null;
  const result = comparisonResult(target, coverage, hasFolderContent);
  const emptyFolder = target && !hasFolderContent && siteAnalysisReady(source) && sourceStatus.tone === "ready";
  const showScan = target && (!siteAnalysisReady(target) || target.scan_state === "failed") && targetStatus?.tone !== "active";
  const scanLabel = target?.hash_status === "pending" ? "Resume target scan" : "Scan target";

  return (
    <section className="atlas-coverage-footer" aria-label="Coverage comparison">
      <div className="atlas-coverage-main">
        <div className="atlas-coverage-pair" role="group" aria-label="Comparison direction">
          <div className="atlas-coverage-site">
            <strong title={source.name} aria-describedby={sourceStatusId}>{source.name}</strong>
            <small id={sourceStatusId} data-tone={sourceStatus.tone} title={sourceStatus.text}>{sourceStatus.text}</small>
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
                aria-describedby={targetStatus ? targetStatusId : undefined}
                title={target?.name ?? "Choose a comparison target"}
                onChange={(event) => onTargetChange(event.currentTarget.value)}
              >
                {!target && <option value="" disabled>Choose a site</option>}
                {targets.map((site) => <option value={site.id} key={site.id}>{site.name}</option>)}
              </select>
            ) : <span className="atlas-coverage-no-target">No comparison target</span>}
            {targetStatus && (
              <small id={targetStatusId} data-tone={targetStatus.tone} title={targetStatus.text}>{targetStatus.text}</small>
            )}
          </div>
        </div>
        {target && (
          <button
            className="atlas-coverage-swap" type="button" aria-label="Swap source and target" title="Swap source and target"
            aria-disabled={navigationBusy || undefined} onClick={navigationBusy ? undefined : onSwap}
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
        <div className="atlas-coverage-status" role="status">
          <span data-tone={navigationBusy ? undefined : result.tone}>{navigationBusy ? "Updating comparison…" : result.text}</span>
          {!navigationBusy && emptyFolder && <span className="atlas-coverage-empty">No content in this folder to compare.</span>}
        </div>
        {showScan && (
          <button className="atlas-coverage-action" type="button" disabled={!canScanTarget} onClick={onScanTarget}>
            <RefreshIcon /> {scanLabel}
          </button>
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
