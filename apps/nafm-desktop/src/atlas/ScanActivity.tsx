import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { formatCount } from "../lib/format";
import { scanRecovery, scanPhaseLabel, scanSitePublishedInventory } from "../lib/scanView";
import type {
  ScanActivityResult, ScanCompletionView, ScanInterruption, ScanProgressView, ScanTask, ScanTaskSiteState, SiteOverview,
} from "../lib/types";
import { CheckIcon, RefreshIcon, WarningIcon } from "../management/Icons";
import { ToolbarDisclosure } from "./ToolbarDisclosure";
import "./scan-activity.css";

export interface ScanActivityProps {
  sites: readonly SiteOverview[];
  tasks: ReadonlyMap<number, ScanTask>;
  progressBySite: ReadonlyMap<string, ScanProgressView>;
  completionBySite: ReadonlyMap<string, ScanCompletionView>;
  cancellingRequestIds: ReadonlySet<number>;
  blockedSiteIds: ReadonlySet<string>;
  scanInterruptions: ReadonlyMap<string, ScanInterruption>;
  lastResult: ScanActivityResult | null;
  onStop: (requestId: number) => void;
  onScan: (siteId: string) => Promise<void>;
}

const resultLabels = {
  completed: "Scan finished",
  cancelled: "Scan stopped",
  failed: "Scan failed",
} satisfies Record<ScanActivityResult["kind"], string>;

function fileCount(count: number) {
  return `${formatCount(count)} ${count === 1 ? "file" : "files"}`;
}

function verificationSummary(total: number | null, pending: number): string | null {
  if (pending > 0) return `${fileCount(pending)} awaiting verification`;
  if (total === 0) return "No files found";
  return total === null ? null : `${fileCount(total)} verified`;
}

function activityIsStopping(task: ScanTask, cancellingRequestIds: ReadonlySet<number>) {
  return task.status === "cancelling" || cancellingRequestIds.has(task.request_id);
}

interface ScanRecovery {
  site: SiteOverview;
  action: "Resume verification" | "Retry scan" | "Restart scan";
  summary: string | null;
  interruption?: ScanInterruption;
}

type RemovedActivityFocus = { kind: "request" } | { kind: "recovery"; siteId: string };

const unsavedInventory = "Inventory wasn’t saved";
const retainedInventory = "Indexed files remain available";

function scanRecoveries({ sites, blockedSiteIds, scanInterruptions, lastResult }: ScanActivityProps) {
  const latestStates = new Map(lastResult?.site_states.map((state) => [state.site_id, state]));
  const recoveries = new Map<string, ScanRecovery>();
  for (const site of sites) {
    if (blockedSiteIds.has(site.id)) continue;
    const interruption = scanInterruptions.get(site.id);
    const recovery = scanRecovery(interruption?.kind);
    if (interruption && recovery) {
      recoveries.set(site.id, {
        site, action: recovery.action, interruption,
        summary: interruption.has_inventory
          ? verificationSummary(null, site.pending_hash_count) ?? retainedInventory
          : unsavedInventory,
      });
      continue;
    }
    const state = latestStates.get(site.id);
    if (state?.status === "completed" && state.hashes_pending === 0) continue;
    const pending = site.latest_inventory_at ? site.pending_hash_count
      : state && scanSitePublishedInventory(state) ? state.hashes_pending : 0;
    if (pending > 0) {
      recoveries.set(site.id, {
        site, action: "Resume verification", summary: verificationSummary(null, pending),
      });
    }
  }
  return recoveries;
}

function SiteProgress({ name, showName, snapshot, progress, completion, stopping }: {
  name: string;
  showName: boolean;
  snapshot?: ScanTaskSiteState;
  progress?: ScanProgressView;
  completion?: ScanCompletionView;
  stopping: boolean;
}) {
  const phase = progress?.phase ?? snapshot?.phase;
  const total = progress ? progress.total_files : snapshot?.total_files ?? null;
  const processed = progress?.processed_files ?? snapshot?.processed_files ?? 0;
  const complete = Boolean(completion) || snapshot?.status === "completed";
  const queued = !progress && snapshot?.status === "queued";
  const verifying = phase === "hashing" && total !== null && total > 0;
  const status = stopping ? "Stopping…" : queued ? "Queued" : phase ? scanPhaseLabel(phase) : "Starting scan";
  const counts = verifying && !stopping ? `${formatCount(processed)} of ${fileCount(total)}` : null;
  const summary = complete
    ? verificationSummary(completion?.total_files ?? total, completion?.pending_files ?? snapshot?.hashes_pending ?? 0) ?? "Indexed"
    : status;

  return (
    <li className="atlas-scan-site">
      {showName && <strong>{name}</strong>}
      <div className="atlas-scan-site-status">
        <span>{summary}</span>
        {!complete && counts && <span>{counts}</span>}
      </div>
      {!complete && !stopping && !queued && (
        <progress max={verifying ? total : 1} value={verifying ? processed : undefined}
          aria-label={`Scan progress for ${name}`} aria-valuetext={counts ? `${status}, ${counts}` : status} />
      )}
    </li>
  );
}

function focusActivityItem(item: HTMLElement | null | undefined) {
  if (!item) return;
  item.focus({ preventScroll: true });
  const scroller = item.closest<HTMLElement>(".atlas-toolbar-panel");
  if (!scroller) return;
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  const bounds = item.getBoundingClientRect();
  const above = bounds.top - top;
  const below = bounds.bottom - (top + scroller.clientHeight);
  // Reveal the nearest edge inside the disclosure, including for results taller than its viewport.
  if (above < 0 && below < 0) scroller.scrollTop += Math.max(above, below);
  if (above > 0 && below > 0) scroller.scrollTop += Math.min(above, below);
}

function ActivityPanel({
  tasks, sites, progressBySite, completionBySite, cancellingRequestIds, scanInterruptions, lastResult, onStop, onScan, recoveries,
}: ScanActivityProps & { recoveries: ReadonlyMap<string, ScanRecovery> }) {
  const panel = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLElement>(null);
  const restoreFocus = useRef<RemovedActivityFocus | null>(null);
  const focusAfterStart = useRef<{ siteId: string; button: HTMLButtonElement } | null>(null);
  const [startingIds, setStartingIds] = useState<ReadonlySet<string>>(new Set());
  const trackRequest = useCallback((request: HTMLElement | null) => {
    if (!request) return;
    return () => {
      if (request.contains(document.activeElement)) restoreFocus.current = { kind: "request" };
    };
  }, []);
  const trackRecovery = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      const siteId = button.dataset.scanRecovery;
      if (siteId && document.activeElement === button) restoreFocus.current = { kind: "recovery", siteId };
    };
  }, []);

  useLayoutEffect(() => {
    const start = focusAfterStart.current;
    const activeTask = start && [...tasks.values()].find((task) => task.selector.site_id === start.siteId);
    if (activeTask) {
      focusAfterStart.current = null;
      if (document.activeElement === document.body || document.activeElement === start.button) {
        const request = panel.current?.querySelector<HTMLElement>(`[data-scan-request="${activeTask.request_id}"]`);
        focusActivityItem(request);
      }
    } else if (start && !startingIds.has(start.siteId)) {
      focusAfterStart.current = null;
    }
    const removed = restoreFocus.current;
    restoreFocus.current = null;
    if (!removed || document.activeElement !== document.body) return;
    const recovery = removed.kind === "recovery"
      ? panel.current?.querySelector<HTMLButtonElement>(`[data-scan-recovery="${CSS.escape(removed.siteId)}"]`)
      : null;
    focusActivityItem(recovery ?? result.current ?? panel.current);
  }, [tasks, lastResult, startingIds, recoveries]);

  const names = new Map(sites.map((site) => [site.id, site.name]));
  const siteName = (id: string | undefined) => (id && names.get(id)) || "Storage site";
  const reportedSiteIds = new Set(lastResult?.site_states.map((state) => state.site_id));
  const belongsInLatestResult = ({ site, interruption }: ScanRecovery) => reportedSiteIds.has(site.id)
    && (!interruption || interruption.request_id === lastResult?.request_id);
  const unlisted = [...recoveries.values()].filter((recovery) => !belongsInLatestResult(recovery));
  const interrupted = unlisted.filter((recovery) => recovery.interruption);
  const verificationPending = unlisted.filter((recovery) => !recovery.interruption);

  function recoveryRow({ site, action, summary, interruption }: ScanRecovery, resultSummary = summary, inLatestResult = false) {
    const starting = startingIds.has(site.id);
    const reason = interruption?.message;
    return (
      <li key={site.id} className="atlas-scan-site atlas-scan-recovery-row">
        <div>
          <strong>{site.name}</strong>
          {resultSummary && <div className="atlas-scan-site-status">{resultSummary}</div>}
          {reason && (!inLatestResult || reason !== lastResult?.message) && <div className="atlas-scan-site-status">{reason}</div>}
        </div>
        <button ref={trackRecovery} data-scan-recovery={site.id} className="atlas-scan-action atlas-scan-resume" type="button"
          aria-label={`${action} of ${site.name}`} aria-disabled={starting || undefined} onClick={async (event) => {
            if (starting) return;
            const button = event.currentTarget;
            button.focus({ preventScroll: true });
            focusAfterStart.current = { siteId: site.id, button };
            setStartingIds((ids) => new Set(ids).add(site.id));
            try {
              await onScan(site.id);
            } finally {
              setStartingIds((ids) => {
                const next = new Set(ids);
                next.delete(site.id);
                return next;
              });
            }
          }}
        >
          {starting ? "Starting…" : action}
        </button>
      </li>
    );
  }

  return (
    <div className="atlas-scan-activity-panel" ref={panel} tabIndex={-1}>
      {[...tasks.values()].map((task) => {
        const states = new Map(task.site_states.map((site) => [site.site_id, site]));
        const selectedId = task.selector.site_id;
        const siteIds = states.size ? [...states.keys()] : task.selector.all ? [...names.keys()] : selectedId ? [selectedId] : [];
        const name = task.selector.all ? "All sites" : siteName(siteIds[0]);
        const stopping = activityIsStopping(task, cancellingRequestIds);
        const stopLabel = task.selector.all ? "Stop all scans" : `Stop scan of ${name}`;
        return (
          <section key={task.request_id} ref={trackRequest} className="atlas-scan-request"
            aria-label={name} tabIndex={-1} data-scan-request={task.request_id}>
            <div className="atlas-scan-request-header">
              <strong>{name}</strong>
              <button className="atlas-scan-action" type="button" aria-label={stopLabel}
                aria-disabled={stopping || undefined} onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  if (!stopping) onStop(task.request_id);
                }}
              >
                {stopping ? "Stopping…" : task.selector.all ? "Stop all" : "Stop"}
              </button>
            </div>
            <ul className="atlas-scan-site-list" role="list">
              {siteIds.map((id) => {
                const live = progressBySite.get(id);
                const final = completionBySite.get(id);
                return (
                  <SiteProgress key={id} name={siteName(id)} showName={Boolean(task.selector.all)} snapshot={states.get(id)}
                    progress={live?.request_id === task.request_id ? live : undefined}
                    completion={final?.request_id === task.request_id ? final : undefined} stopping={stopping}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
      {lastResult && (
        <section className="atlas-scan-request atlas-scan-result" ref={result} tabIndex={-1} aria-label="Latest scan result">
          <strong>{resultLabels[lastResult.kind]}</strong>
          {lastResult.message && <p>{lastResult.message}</p>}
          <ul className="atlas-scan-site-list" role="list">
            {lastResult.site_states.map((state) => {
              const recovery = recoveries.get(state.site_id);
              const interruption = scanInterruptions.get(state.site_id);
              const summary = interruption?.request_id === lastResult.request_id && !interruption.has_inventory ? unsavedInventory
                : scanSitePublishedInventory(state) ? verificationSummary(state.total_files, state.hashes_pending) : null;
              if (recovery && belongsInLatestResult(recovery)) return recoveryRow(recovery, summary ?? recovery.summary, true);
              return (
                <li key={state.site_id} className="atlas-scan-site">
                  <strong>{siteName(state.site_id)}</strong>
                  {summary && <div className="atlas-scan-site-status">{summary}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {interrupted.length > 0 && (
        <section className="atlas-scan-request" aria-label="Interrupted scans">
          <strong>Interrupted scans</strong>
          <ul className="atlas-scan-site-list" role="list">{interrupted.map((recovery) => recoveryRow(recovery))}</ul>
        </section>
      )}
      {verificationPending.length > 0 && (
        <section className="atlas-scan-request" aria-label="Verification pending">
          <strong>Verification pending</strong>
          <ul className="atlas-scan-site-list" role="list">{verificationPending.map((recovery) => recoveryRow(recovery))}</ul>
        </section>
      )}
    </div>
  );
}

export function ScanActivity(props: ScanActivityProps) {
  const { tasks, lastResult, cancellingRequestIds } = props;
  const recoveries = scanRecoveries(props);
  const active = [...tasks.values()];
  const stopping = active.length > 0 && active.every((task) => activityIsStopping(task, cancellingRequestIds));
  const idleSummary = [...recoveries.values()].some((recovery) => recovery.interruption) ? "Interrupted scans"
    : recoveries.size ? "Verification pending" : null;
  const summary = active.length > 1 ? `${formatCount(active.length)} scans`
    : active.length === 1 ? (stopping ? "Stopping…" : "Scanning")
    : lastResult && lastResult.kind !== "completed" ? resultLabels[lastResult.kind]
    : idleSummary ?? (lastResult ? resultLabels[lastResult.kind] : null);
  const pending = lastResult?.site_states.reduce((total, site) => total + site.hashes_pending, 0) ?? 0;
  const verified = Boolean(lastResult?.site_states.length) && pending === 0 && lastResult?.kind === "completed"
    && lastResult.site_states.every((site) => site.status === "completed");
  const state = active.length > 0 ? (stopping ? "stopping" : "running")
    : lastResult?.kind === "failed" ? "failed"
    : recoveries.size ? "pending" : lastResult?.kind;
  const Icon = state === "failed" ? WarningIcon : verified && state === "completed" ? CheckIcon : RefreshIcon;

  return (
    <>
      <span className="atlas-scan-announcement" role="status">
        {lastResult?.kind === "completed" && (pending ? `Scan finished. ${fileCount(pending)} awaiting verification.` : "Scan finished.")}
      </span>
      {summary && (
        <ToolbarDisclosure label="Scan activity" className="atlas-scan-disclosure" summary={summary} description={summary}
          icon={<span className="atlas-scan-icon" data-state={state}><Icon /></span>}
        >
          {() => <ActivityPanel {...props} recoveries={recoveries} />}
        </ToolbarDisclosure>
      )}
    </>
  );
}
