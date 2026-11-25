import { useState, type RefCallback } from "react";
import { formatCount } from "../lib/format";
import { scanRecovery, scanPhaseLabel } from "../lib/scanView";
import type { ScanInterruption, ScanProgressView } from "../lib/types";

export interface FirstScanState {
  requestId?: number;
  progress?: ScanProgressView;
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
  const [starting, setStarting] = useState(false);
  const running = scan.requestId !== undefined;
  const progress = scan.progress?.request_id === scan.requestId ? scan.progress : undefined;
  const unavailable = scan.stopping || starting || (!running && scan.blocked);
  const recovery = scanRecovery(scan.interruption);
  let status = recovery?.status ?? "Ready to scan";
  if (scan.stopping) status = "Stopping scan";
  else if (progress) status = scanPhaseLabel(progress.phase);
  else if (running || starting) status = "Starting scan";

  async function activate() {
    if (scan.requestId !== undefined) {
      scan.onCancel(scan.requestId);
      return;
    }
    setStarting(true);
    try {
      await scan.onScan();
    } finally {
      setStarting(false);
    }
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
        <button
          ref={trackFocus}
          type="button"
          className="radial-atlas__scan-action"
          data-running={running || undefined}
          aria-disabled={unavailable || undefined}
          onClick={(event) => {
            if (event.detail > 1 || unavailable) return;
            event.currentTarget.focus({ preventScroll: true });
            void activate();
          }}
        >
          {running ? scan.scanAll ? "Stop all scans" : "Stop scan" : recovery?.action ?? "Scan this site"}
        </button>
      )}
    </>
  );
}
