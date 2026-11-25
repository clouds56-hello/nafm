import { useCallback, useLayoutEffect, useRef } from "react";
import { formatCount } from "../lib/format";
import { scanPhaseLabel } from "../lib/scanView";
import type {
  ScanActivityResult, ScanCompletionView, ScanProgressView, ScanTask, ScanTaskSiteState, SiteOverview,
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
  lastResult: ScanActivityResult | null;
  onStop: (requestId: number) => void;
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

function ActivityPanel({ tasks, sites, progressBySite, completionBySite, cancellingRequestIds, lastResult, onStop }: ScanActivityProps) {
  const panel = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const trackStopButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => { restoreFocus.current ||= document.activeElement === button; };
  }, []);

  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement !== document.body) return;
    (result.current ?? panel.current)?.focus({ preventScroll: true });
  }, [tasks, lastResult]);

  const names = new Map(sites.map((site) => [site.id, site.name]));
  const siteName = (id: string | undefined) => (id && names.get(id)) || "Storage site";

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
          <section key={task.request_id} className="atlas-scan-request" aria-label={name}>
            <div className="atlas-scan-request-header">
              <strong>{name}</strong>
              <button ref={trackStopButton} className="atlas-scan-stop" type="button" aria-label={stopLabel}
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
              const summary = state.status === "completed" || state.phase === "hashing" || state.phase === "finalizing"
                ? verificationSummary(state.total_files, state.hashes_pending) : null;
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
    </div>
  );
}

export function ScanActivity(props: ScanActivityProps) {
  const { tasks, lastResult, cancellingRequestIds } = props;
  const active = [...tasks.values()];
  const stopping = active.length > 0 && active.every((task) => activityIsStopping(task, cancellingRequestIds));
  const summary = active.length > 1 ? `${formatCount(active.length)} scans`
    : active.length === 1 ? (stopping ? "Stopping…" : "Scanning") : lastResult ? resultLabels[lastResult.kind] : null;
  const pending = lastResult?.site_states.reduce((total, site) => total + site.hashes_pending, 0) ?? 0;
  const verified = Boolean(lastResult?.site_states.length) && pending === 0 && lastResult?.kind === "completed"
    && lastResult.site_states.every((site) => site.status === "completed");
  const state = active.length > 0 ? (stopping ? "stopping" : "running") : lastResult?.kind;
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
          {() => <ActivityPanel {...props} />}
        </ToolbarDisclosure>
      )}
    </>
  );
}
