import { useEffect, useRef } from "react";
import { fileName, formatBytes, formatCount } from "../lib/format";
import type { CleanupPreview, DuplicateFile, StageWarning } from "../lib/types";
import { CheckIcon, CloseIcon, LayersIcon, WarningIcon } from "./Icons";

interface ReviewDrawerProps {
  open: boolean;
  staged: DuplicateFile[];
  hashesPending: number;
  cleanupReady: boolean;
  warnings: StageWarning[];
  preview: CleanupPreview | null;
  loadingPreview: boolean;
  error: string | null;
  onClose: () => void;
  onPreview: () => void;
  onRemove: (path: string) => void;
}

export function ReviewDrawer({
  open,
  staged,
  hashesPending,
  cleanupReady,
  warnings,
  preview,
  loadingPreview,
  error,
  onClose,
  onPreview,
  onRemove,
}: ReviewDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, open]);

  const total = staged.reduce((sum, file) => sum + file.size_bytes, 0);
  const effectiveHashesPending = Math.max(hashesPending, preview?.hashes_pending ?? 0);
  const effectiveWarnings = preview && !preview.cleanup_ready ? preview.warnings : warnings;
  const effectiveCleanupReady = cleanupReady
    && (preview?.cleanup_ready ?? true)
    && effectiveHashesPending === 0;
  const previewReady = Boolean(preview?.cleanup_ready && cleanupReady && effectiveHashesPending === 0);
  const warningReasons = new Set(effectiveWarnings.map((warning) => warning.reason));
  const warningCopy = [
    warningReasons.has("not_tracked") ? "some files are no longer tracked" : null,
    warningReasons.has("not_duplicate") ? "some files are not currently verified duplicates" : null,
    warningReasons.has("would_remove_last_copy") ? "a selection would remove the last copy" : null,
    warningReasons.has("already_staged") ? "some files were already staged" : null,
    warningReasons.has("not_staged") ? "some files are no longer staged" : null,
  ].filter((reason): reason is string => reason !== null).join("; ");
  return (
    <>
      <button className={`drawer-scrim ${open ? "is-open" : ""}`} type="button" aria-label="Close review" onClick={onClose} tabIndex={open ? 0 : -1} />
      <aside className={`review-drawer ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open} aria-label="Cleanup review">
        <header className="drawer-header">
          <div><span className="eyebrow">CLEANUP REVIEW</span><h2>Staged copies</h2></div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close review"><CloseIcon /></button>
        </header>

        <div className="review-summary">
          <span className="review-summary-icon"><LayersIcon /></span>
          <div><strong>{formatBytes(total)}</strong><span>{formatCount(staged.length)} {staged.length === 1 ? "copy" : "copies"} selected</span></div>
        </div>

        <div className="drawer-content">
          {staged.length === 0 ? (
            <div className="drawer-empty"><LayersIcon /><h3>Nothing staged</h3><p>Select a duplicate-heavy arc, then add it to review.</p></div>
          ) : (
            <ul className="staged-list">
              {staged.map((file) => (
                <li key={file.file_id}>
                  <span className="file-copy"><strong>{fileName(file.path)}</strong><small title={file.path}>{file.path}</small></span>
                  <span className="file-size">{formatBytes(file.size_bytes)}</span>
                  <button
                    className="remove-button"
                    type="button"
                    onClick={() => onRemove(file.path)}
                    disabled={loadingPreview}
                    aria-label={`Remove ${fileName(file.path)} from review`}
                  ><CloseIcon /></button>
                </li>
              ))}
            </ul>
          )}

          {effectiveHashesPending > 0 && (
            <div className="inline-alert warning" role="status">
              <WarningIcon />
              <p>
                Cleanup is suspended while {formatCount(effectiveHashesPending)} staged {effectiveHashesPending === 1 ? "hash is" : "hashes are"} pending.
                Finish hashing or remove those copies before previewing cleanup.
              </p>
            </div>
          )}
          {effectiveHashesPending === 0 && !effectiveCleanupReady && (
            <div className="inline-alert warning" role="status">
              <WarningIcon />
              <p>
                Cleanup is suspended: {warningCopy || `${formatCount(effectiveWarnings.length)} staged selections need review`}.
                Remove affected copies or rescan before previewing cleanup.
              </p>
            </div>
          )}
          {error && <div className="inline-alert danger"><WarningIcon /><p>{error}</p></div>}
          {preview && (
            <div className={`preview-card ${previewReady ? "" : "is-pending"}`}>
              <div className="preview-title">
                {previewReady ? <CheckIcon /> : <WarningIcon />}
                <strong>{previewReady ? "Safety check passed" : "Cleanup is not ready"}</strong>
              </div>
              <dl>
                <div><dt>Tracked files</dt><dd>{formatCount(preview.tracked_file_count_before)} → {formatCount(preview.tracked_file_count_after)}</dd></div>
                <div><dt>Duplicate copies</dt><dd>{formatCount(preview.duplicate_file_count_before)} → {formatCount(preview.duplicate_file_count_after)}</dd></div>
                <div><dt>Database records</dt><dd>{preview.db_entry_count_stable ? "Stable" : "Needs attention"}</dd></div>
              </dl>
            </div>
          )}
        </div>

        <footer className="drawer-footer">
          <p><WarningIcon /> Preview only. NAFM will not delete files in this release.</p>
          <button
            className="primary-button full-width"
            type="button"
            onClick={onPreview}
            disabled={staged.length === 0 || loadingPreview || !effectiveCleanupReady}
          >
            {loadingPreview
              ? "Checking…"
              : effectiveHashesPending > 0 ? "Hashes pending" : !effectiveCleanupReady ? "Cleanup suspended" : "Preview cleanup"}
          </button>
        </footer>
      </aside>
    </>
  );
}
