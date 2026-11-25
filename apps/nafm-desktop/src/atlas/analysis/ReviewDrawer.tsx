import { useEffect, useLayoutEffect, useRef } from "react";
import { fileName, formatBytes, formatCount } from "../../lib/format";
import type { CleanupPreview, DuplicateFile, SiteOverview, StageWarning, StageWarningReason } from "../../lib/types";
import { AnalysisDialog } from "./AnalysisDialog";
import { useAnalysisNavigation } from "./useAnalysisNavigation";
import "./cleanup-review.css";

export interface ReviewPosition {
  file_id: string;
  scroll_top: number;
}

interface ReviewDrawerProps {
  open: boolean;
  staged: DuplicateFile[];
  sites: readonly SiteOverview[];
  hashesPending: number;
  cleanupReady: boolean;
  warnings: StageWarning[];
  preview: CleanupPreview | null;
  loadingPreview: boolean;
  stagingBusy?: boolean;
  error: string | null;
  position: ReviewPosition | null;
  onClose: () => void;
  onPreview: () => void;
  onRemove: (path: string) => void;
  onInspect: (file: DuplicateFile, signal: AbortSignal) => Promise<string | null>;
  onInspected: (file: DuplicateFile, position: ReviewPosition) => void;
}

const warningLabels: Record<StageWarningReason, string> = {
  not_tracked: "Missing from the index",
  not_duplicate: "No verified duplicate",
  already_staged: "Already staged",
  not_staged: "No longer staged",
  would_remove_last_copy: "Would remove the last copy",
};

interface ReviewFileProps {
  file: DuplicateFile;
  site?: string;
  warning?: string;
  disabled: boolean;
  onRemove?: (path: string) => void;
  onInspect?: (file: DuplicateFile) => void;
}

function ReviewFile({ file, site, warning, disabled, onRemove, onInspect }: ReviewFileProps) {
  const name = fileName(file.path);
  const description = site ? `${site} · ${file.path}` : file.path;
  return (
    <li className="atlas-review-file">
      <div>
        <strong>{name}</strong>
        {site && <span className="atlas-review-site">{site}</span>}
        <code>{file.path}</code>
        {warning && <span className="atlas-review-file-warning">{warning}</span>}
      </div>
      <div className="atlas-review-file-actions">
        <span>{formatBytes(file.size_bytes)}</span>
        {(onInspect || onRemove) && (
          <div className="atlas-review-file-buttons">
            {onInspect && (
              <button
                type="button" data-review-inspect={file.file_id} aria-disabled={disabled || undefined}
                aria-label={`Inspect ${name} in Atlas`} aria-description={description}
                onClick={disabled ? undefined : (event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  onInspect(file);
                }}
              >
                Inspect
              </button>
            )}
            {onRemove && (
              <button
                type="button" className="atlas-review-unstage" disabled={disabled}
                aria-label={`Remove ${name} from review`} aria-description={description}
                onClick={() => onRemove(file.path)}
              >
                Remove from review
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function ReviewDrawer({ open, ...props }: ReviewDrawerProps) {
  return open ? <OpenReviewDrawer {...props} /> : null;
}

function OpenReviewDrawer({
  staged,
  sites,
  hashesPending,
  cleanupReady,
  warnings,
  preview,
  loadingPreview,
  stagingBusy,
  error,
  position,
  onClose,
  onPreview,
  onRemove,
  onInspect,
  onInspected,
}: Omit<ReviewDrawerProps, "open">) {
  const results = useRef<HTMLDivElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const previewSummary = useRef<HTMLElement>(null);
  const initialPosition = useRef(position);
  const previousPreview = useRef(preview);
  const navigation = useAnalysisNavigation(
    ({ file }: { file: DuplicateFile; position: ReviewPosition }, signal) => onInspect(file, signal),
    onClose,
    ({ file, position }) => onInspected(file, position),
  );

  useLayoutEffect(() => {
    const saved = initialPosition.current;
    if (!saved) return;
    const button = results.current?.querySelector<HTMLButtonElement>(
      `[data-review-inspect="${CSS.escape(saved.file_id)}"]:not([aria-disabled="true"])`,
    );
    const body = results.current?.closest(".atlas-analysis-body");
    if (!button || !body) {
      const previewAction = previewButton.current;
      (previewSummary.current ?? (previewAction?.disabled ? null : previewAction))?.focus();
      return;
    }

    body.scrollTop = saved.scroll_top;
    button.focus({ preventScroll: true });
    const bounds = body.getBoundingClientRect();
    const row = button.getBoundingClientRect();
    if (row.top < bounds.top || row.bottom > bounds.bottom) button.scrollIntoView({ block: "nearest" });
  }, []);

  useEffect(() => {
    if (preview && (!initialPosition.current || preview !== previousPreview.current)) previewSummary.current?.focus();
    previousPreview.current = preview;
  }, [preview]);

  const totalBytes = staged.reduce((sum, file) => sum + file.size_bytes, 0);
  const pending = Math.max(hashesPending, preview?.hashes_pending ?? 0);
  const blockedWarnings = preview && !preview.cleanup_ready ? preview.warnings : warnings;
  const effectiveReady = cleanupReady && (preview?.cleanup_ready ?? true) && pending === 0;
  const busy = Boolean(loadingPreview || stagingBusy || navigation.opening);
  const canPreview = staged.length > 0 && effectiveReady && !busy;
  const blockedPaths = new Map(blockedWarnings.map(({ path, reason }) => [path, reason]));
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));
  const stagedById = new Map(staged.map((file) => [file.file_id, file]));
  const readyPreview = effectiveReady && preview?.db_entry_count_stable ? preview : null;
  const groups = readyPreview?.review_groups ?? [];
  const groupedIds = new Set(groups.flatMap((group) => group.staged_file_ids));
  const ungrouped = staged.filter((file) => !groupedIds.has(file.file_id));

  function inspectFile(file: DuplicateFile) {
    const body = results.current?.closest(".atlas-analysis-body");
    void navigation.show({ file, position: { file_id: file.file_id, scroll_top: body?.scrollTop ?? 0 } });
  }

  return (
    <AnalysisDialog
      title="Cleanup review"
      className="atlas-cleanup-review"
      drawer
      onClose={navigation.close}
      footer={
        <>
          {navigation.error && <p className="atlas-review-inspect-error" role="alert">{navigation.error}</p>}
          <span role={navigation.opening ? "status" : undefined}>{navigation.opening ? "Opening file…" : "Preview only"}</span>
          <button type="button" className="atlas-analysis-primary" ref={previewButton} onClick={onPreview} disabled={!canPreview}>
            {loadingPreview ? "Checking…" : "Preview cleanup"}
          </button>
        </>
      }
    >
      <div className="atlas-analysis-results" ref={results}>
        <dl className="atlas-analysis-facts">
          <div><dt>Staged copies</dt><dd>{formatCount(staged.length)}</dd></div>
          <div><dt>Staged file size</dt><dd>{formatBytes(totalBytes)}</dd></div>
        </dl>
        {staged.length === 0 && (
          <p role="status">No copies staged. Select a folder or file with verified duplicates to start a review.</p>
        )}
        {staged.length > 0 && effectiveReady && !preview && !loadingPreview && !error && (
          <p role="status">Preview cleanup to see which copies would remain.</p>
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
          <section
            className="atlas-comparison-details atlas-review-result" aria-label="Cleanup preview" ref={previewSummary} tabIndex={-1}
            data-ready={readyPreview ? "" : undefined}
          >
            {readyPreview ? (
              <>
                <h3>Preview passed</h3>
                <dl className="atlas-analysis-values">
                  <div><dt>Estimated space reclaimed</dt><dd>{formatBytes(readyPreview.staged_files.reduce((sum, file) => sum + file.size_bytes, 0))}</dd></div>
                  <div><dt>Tracked files</dt><dd>{formatCount(readyPreview.tracked_file_count_before)} → {formatCount(readyPreview.tracked_file_count_after)}</dd></div>
                  <div><dt>Duplicate groups</dt><dd>{formatCount(readyPreview.duplicate_group_count_before)} → {formatCount(readyPreview.duplicate_group_count_after)}</dd></div>
                </dl>
              </>
            ) : preview.cleanup_ready && !preview.db_entry_count_stable ? (
              <p role="status">The index changed during the check. Run another preview.</p>
            ) : (
              <h3>Preview blocked</h3>
            )}
          </section>
        )}
        {groups.map((group) => {
          const removing = group.staged_file_ids.flatMap((id) => stagedById.get(id) ?? []);
          return (
            <section className="atlas-review-group" key={group.group_id} aria-label="Exact copy group">
              <div>
                <h3>Staged for cleanup</h3>
                <ul className="atlas-review-files" aria-label="Staged for cleanup">
                  {removing.map((file) => (
                    <ReviewFile key={file.file_id} file={file} site={siteNames.get(file.site_id)}
                      disabled={busy} onInspect={inspectFile} onRemove={onRemove} />
                  ))}
                </ul>
              </div>
              <div className="atlas-review-retained">
                <h3>Would remain</h3>
                <ul className="atlas-review-files" aria-label="Would remain">
                  {group.retained_files.map((file) => (
                    <ReviewFile key={file.file_id} file={file} site={siteNames.get(file.site_id)} disabled={busy} onInspect={inspectFile} />
                  ))}
                </ul>
              </div>
            </section>
          );
        })}
        {ungrouped.length > 0 && (
          <ul className="atlas-review-files" aria-label="Staged copies">
            {ungrouped.map((file) => {
              const warning = blockedPaths.get(file.path);
              return (
                <ReviewFile
                  key={file.file_id} file={file} site={siteNames.get(file.site_id)} warning={warning ? warningLabels[warning] : undefined}
                  disabled={busy} onInspect={warning === "not_tracked" ? undefined : inspectFile} onRemove={onRemove}
                />
              );
            })}
          </ul>
        )}
      </div>
    </AnalysisDialog>
  );
}
