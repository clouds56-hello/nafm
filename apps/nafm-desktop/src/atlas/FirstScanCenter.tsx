import { useState } from "react";
import { formatCount } from "../lib/format";
import { scanPhaseLabel } from "../lib/scanView";
import type { ScanProgressView } from "../lib/types";

export interface FirstScanState {
  requestId?: number;
  progress?: ScanProgressView;
  stopping: boolean;
  scanAll: boolean;
  blocked: boolean;
  failed: boolean;
  onScan: () => Promise<void>;
  onCancel: (requestId: number) => void;
}

export function FirstScanCenter({ name, scan }: { name: string; scan: FirstScanState }) {
  const [starting, setStarting] = useState(false);
  const running = scan.requestId !== undefined;
  const progress = scan.progress?.request_id === scan.requestId ? scan.progress : undefined;
  const unavailable = scan.stopping || starting || (!running && scan.blocked);
  let status = scan.failed ? "Scan failed" : "Ready to scan";
  if (scan.stopping) status = "Stopping scan";
  else if (progress) status = scanPhaseLabel(progress.phase);
  else if (running || starting) status = "Starting scan";

  async function activate() {
    if (unavailable) return;
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
      <strong className="radial-atlas__scan-status" role="status">{status}</strong>
      {progress && (
        <span className="radial-atlas__detail">
          {formatCount(progress.processed_files)}{progress.total_files !== null && ` / ${formatCount(progress.total_files)}`}
          {(progress.total_files ?? progress.processed_files) === 1 ? " file" : " files"}
        </span>
      )}
      <button
        type="button"
        className="radial-atlas__scan-action"
        data-running={running || undefined}
        aria-disabled={unavailable || undefined}
        onClick={(event) => { if (event.detail <= 1) void activate(); }}
      >
        {running ? scan.scanAll ? "Stop all scans" : "Stop scan" : scan.failed ? "Retry scan" : "Scan this site"}
      </button>
    </>
  );
}
