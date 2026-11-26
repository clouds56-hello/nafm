import type { RefCallback } from "react";
import { formatCount } from "../lib/format";
import { scanRecovery, scanPhaseLabel } from "../lib/scanView";
import type { ScanInterruption, ScanProgressView } from "../lib/types";
import { ScanActionButton } from "./ScanActionButton";

export interface FirstScanState {
  requestId?: number;
  progress?: ScanProgressView;
  starting: boolean;
  stopping: boolean;
  scanAll: boolean;
  blocked: boolean;
  inventoryLoading: boolean;
  interruption?: ScanInterruption["kind"];
  onScan: () => Promise<void>;
  onCancel: (requestId: number) => void;
}

interface FirstScanCenterProps {
  name: string;
  scan: FirstScanState;
  trackFocus: RefCallback<HTMLElement>;
}

export function FirstScanCenter({ name, scan, trackFocus }: FirstScanCenterProps) {
  const running = scan.requestId !== undefined;
  const progress = scan.progress?.request_id === scan.requestId ? scan.progress : undefined;
  const unavailable = scan.stopping || scan.starting || (!running && scan.blocked);
  const recovery = scanRecovery(scan.interruption);
  let status = recovery?.status ?? "Ready to scan";
  if (scan.stopping) status = "Stopping scan";
  else if (progress) status = scanPhaseLabel(progress.phase);
  else if (running || scan.starting) status = "Starting scan";

  function activate() {
    if (scan.requestId !== undefined) scan.onCancel(scan.requestId);
    else void scan.onScan();
  }

  return (
    <>
      <span className="radial-atlas__name" title={name}>{name}</span>
      <strong className="radial-atlas__scan-status" role="status" tabIndex={-1} ref={trackFocus}>
        {scan.inventoryLoading ? "Loading map" : status}
      </strong>
      {progress && (
        <span className="radial-atlas__detail">
          {scan.inventoryLoading && <><span>{status}</span><br /></>}
          <span>
            {formatCount(progress.processed_files)}{progress.total_files !== null && ` / ${formatCount(progress.total_files)}`}
            {(progress.total_files ?? progress.processed_files) === 1 ? " file" : " files"}
          </span>
        </span>
      )}
      {(running || !scan.inventoryLoading) && (
        <ScanActionButton
          ref={trackFocus}
          className="radial-atlas__scan-action"
          data-running={running || undefined}
          unavailable={unavailable}
          onActivate={activate}
        >
          {running ? scan.scanAll ? "Stop all scans" : "Stop scan" : recovery?.action ?? "Scan this site"}
        </ScanActionButton>
      )}
    </>
  );
}
