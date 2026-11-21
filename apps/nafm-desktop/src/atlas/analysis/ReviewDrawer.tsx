import { fileName, formatBytes, formatCount } from "../../lib/format";
import type { CleanupPreview, DuplicateFile, StageWarning, StageWarningReason } from "../../lib/types";
import { AnalysisDialog } from "./AnalysisDialog";

interface ReviewDrawerProps {
  open: boolean;
  staged: DuplicateFile[];
  hashesPending: number;
  cleanupReady: boolean;
  warnings: StageWarning[];
  preview: CleanupPreview | null;
  loadingPreview: boolean;
  stagingBusy?: boolean;
  error: string | null;
  onClose: () => void;
  onPreview: () => void;
  onRemove: (path: string) => void;
}

const warningLabels: Record<StageWarningReason, string> = {
  not_tracked: "Missing from the index",
  not_duplicate: "No verified duplicate",
  already_staged: "Already staged",
  not_staged: "No longer staged",
  would_remove_last_copy: "Would remove the last copy",
};

export function ReviewDrawer({
  open,
  staged,
  hashesPending,
  cleanupReady,
  warnings,
  preview,
  loadingPreview,
  stagingBusy,
  error,
  onClose,
  onPreview,
  onRemove,
}: ReviewDrawerProps) {
  if (!open) return null;
  const totalBytes = staged.reduce((sum, file) => sum + file.size_bytes, 0);
  const pending = Math.max(hashesPending, preview?.hashes_pending ?? 0);
  const blockedWarnings = preview && !preview.cleanup_ready ? preview.warnings : warnings;
  const effectiveReady = cleanupReady && (preview?.cleanup_ready ?? true) && pending === 0;
  const canPreview = staged.length > 0 && effectiveReady && !loadingPreview && !stagingBusy;
  const blockedPaths = new Map(blockedWarnings.map(({ path, reason }) => [path, warningLabels[reason]]));

  return (
    <AnalysisDialog
      title="Cleanup review"
      drawer
      onClose={onClose}
      footer={
        <>
          <span>Preview only</span>
          <button type="button" className="atlas-analysis-primary" onClick={onPreview} disabled={!canPreview}>
            {loadingPreview ? "Checking…" : "Preview cleanup"}
          </button>
        </>
      }
    >
      <div className="atlas-analysis-results">
        <dl className="atlas-analysis-facts">
          <div><dt>Staged copies</dt><dd>{formatCount(staged.length)}</dd></div>
          <div><dt>Selected size</dt><dd>{formatBytes(totalBytes)}</dd></div>
        </dl>
        {staged.length > 0 ? (
          <ul className="atlas-analysis-list" aria-label="Staged copies">
            {staged.map((file) => (
              <li key={file.file_id} className="atlas-analysis-file">
                <span className="atlas-analysis-location">
                  <strong>{fileName(file.path)}</strong>
                  <small title={file.path}>{file.path}</small>
                  {blockedPaths.has(file.path) && <small className="atlas-analysis-warning">{blockedPaths.get(file.path)}</small>}
                </span>
                <span className="atlas-analysis-file-size">{formatBytes(file.size_bytes)}</span>
                <button type="button" onClick={() => onRemove(file.path)} disabled={loadingPreview || stagingBusy} aria-label={`Remove ${fileName(file.path)} from review`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status">No copies staged. Select a folder or file with verified duplicates to start a review.</p>
        )}
        {pending > 0 && (
          <p className="atlas-analysis-warning" role="status">
            {formatCount(pending)} staged {pending === 1 ? "hash is" : "hashes are"} pending. Finish hashing or remove the affected copies.
          </p>
        )}
        {staged.length > 0 && pending === 0 && !effectiveReady && (
          <div className="atlas-analysis-warning" role="status">
            <strong>Cleanup suspended</strong>
            <p>Remove the affected copies or rescan before previewing cleanup.</p>
          </div>
        )}
        {error && <p className="atlas-analysis-error" role="alert">{error}</p>}
        {preview && (
          <section className="atlas-comparison-details" aria-label="Cleanup preview" aria-live="polite">
            <h3>{effectiveReady ? "Safety check passed" : "Cleanup suspended"}</h3>
            <dl className="atlas-analysis-values">
              <div><dt>Tracked files</dt><dd>{formatCount(preview.tracked_file_count_before)} → {formatCount(preview.tracked_file_count_after)}</dd></div>
              <div><dt>Duplicate copies</dt><dd>{formatCount(preview.duplicate_file_count_before)} → {formatCount(preview.duplicate_file_count_after)}</dd></div>
              <div><dt>Database records</dt><dd>{preview.db_entry_count_stable ? "Stable" : "Needs attention"}</dd></div>
            </dl>
          </section>
        )}
      </div>
    </AnalysisDialog>
  );
}
