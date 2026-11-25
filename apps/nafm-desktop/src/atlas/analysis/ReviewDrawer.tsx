import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { fileName, formatBytes, formatCount } from "../../lib/format";
import type {
  CleanupPreview, DuplicateFile, SiteOverview, StageHistoryDirection, StageHistoryRequest, StageHistoryState,
  StageVerificationBlocker, StageWarning, StageWarningReason,
} from "../../lib/types";
import type { ScanSite, SiteVerification } from "../siteVerification";
import { VerificationScanButton } from "../VerificationScanButton";
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
  verificationBlockers: readonly StageVerificationBlocker[];
  verificationForSite: (id: string) => SiteVerification | undefined;
  stageHistory: StageHistoryState;
  preview: CleanupPreview | null;
  loadingPreview: boolean;
  stagingBusy?: boolean;
  error: string | null;
  position: ReviewPosition | null;
  onClose: () => void;
  onPreview: () => void;
  onScanSite: ScanSite;
  onRemove: (path: string) => void;
  onHistoryStep: (request: StageHistoryRequest) => Promise<boolean>;
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
  onRemove?: (file: DuplicateFile, button: HTMLButtonElement) => void;
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
                type="button" className="atlas-review-unstage" aria-disabled={disabled || undefined}
                aria-label={`Remove ${name} from review`} aria-description={description}
                onClick={disabled ? undefined : (event) => onRemove(file, event.currentTarget)}
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

function ReviewVerificationSite({ name, verification, files, siteId, busy, onScanSite, focusTarget }: {
  name: string;
  verification: SiteVerification;
  files: readonly DuplicateFile[];
  siteId: string;
  busy: boolean;
  onScanSite: ScanSite;
  focusTarget: RefObject<HTMLButtonElement | null>;
}) {
  const noteId = useId();
  const [startError, setStartError] = useState<string | null>(null);
  const ownCopies = files.filter((file) => file.site_id === siteId).length;
  const note = ownCopies === files.length ? "Staged copies need verification."
    : ownCopies === 0 ? "Potential retained copies need verification."
    : "Staged and potential retained copies need verification.";
  const scanError = verification.tone === "active" ? null : startError ?? verification.failure;

  return (
    <li className="atlas-review-verification-site">
      <div>
        <strong>{name}</strong>
        <span className="atlas-review-verification-status" role="status" data-tone={verification.tone}>{verification.status}</span>
        <span id={noteId}>{note}</span>
      </div>
      {verification.action && (
        <VerificationScanButton
          action={{ ...verification.action, disabled: verification.action.disabled || busy }}
          onScanSite={onScanSite} onScanError={setStartError} focusTarget={focusTarget}
          className="atlas-review-verify" describedBy={noteId} siteName={name}
        />
      )}
      {scanError && <p className="atlas-review-inspect-error" role="alert">{scanError}</p>}
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
  verificationBlockers,
  verificationForSite,
  stageHistory,
  preview,
  loadingPreview,
  stagingBusy,
  error,
  position,
  onClose,
  onPreview,
  onScanSite,
  onRemove,
  onHistoryStep,
  onInspect,
  onInspected,
}: Omit<ReviewDrawerProps, "open">) {
  const results = useRef<HTMLDivElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const previewSummary = useRef<HTMLElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const redoButton = useRef<HTMLButtonElement>(null);
  const removalFocus = useRef<{ id: string; button: HTMLButtonElement } | null>(null);
  const [historyAnnouncement, setHistoryAnnouncement] = useState("");
  const blockedMessageId = useId();
  const verificationHeadingId = useId();
  const initialPosition = useRef(position);
  const previousPreview = useRef(preview);
  const navigation = useAnalysisNavigation(
    ({ file }: { file: DuplicateFile; position: ReviewPosition }, signal) => onInspect(file, signal),
    onClose,
    ({ file, position }) => onInspected(file, position),
  );

  const trackHistoryFocus = useCallback((controls: HTMLDivElement | null) => {
    if (!controls) return;
    return () => {
      if (!controls.contains(document.activeElement)) return;
      const fallback = previewButton.current;
      queueMicrotask(() => {
        if (fallback?.isConnected && document.activeElement === document.body) fallback.focus({ preventScroll: true });
      });
    };
  }, []);

  useLayoutEffect(() => {
    const saved = initialPosition.current;
    if (!saved) return;
    const button = results.current?.querySelector<HTMLButtonElement>(
      `[data-review-inspect="${CSS.escape(saved.file_id)}"]:not([aria-disabled="true"])`,
    );
    const body = results.current?.closest(".atlas-analysis-body");
    if (!button || !body) {
      (previewSummary.current ?? previewButton.current)?.focus();
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

  useLayoutEffect(() => {
    const removal = removalFocus.current;
    if (!removal) return;
    if (staged.some((file) => file.file_id === removal.id)) {
      if (!stagingBusy) removalFocus.current = null;
      return;
    }
    removalFocus.current = null;
    if (document.activeElement === document.body || document.activeElement === removal.button) {
      (undoButton.current ?? previewButton.current)?.focus({ preventScroll: true });
    }
  }, [staged, stagingBusy]);

  const totalBytes = staged.reduce((sum, file) => sum + file.size_bytes, 0);
  const pending = Math.max(hashesPending, preview?.hashes_pending ?? 0);
  const blockedWarnings = preview && !preview.cleanup_ready ? preview.warnings : warnings;
  const stagedById = new Map(staged.map((file) => [file.file_id, file]));
  const activeBlockers = (verificationBlockers ?? []).flatMap((blocker) => {
    const files = blocker.staged_file_ids.flatMap((id) => stagedById.get(id) ?? []);
    return files.length ? [{ siteId: blocker.site_id, files }] : [];
  });
  const effectiveReady = cleanupReady && (preview?.cleanup_ready ?? true) && pending === 0 && activeBlockers.length === 0;
  const busy = Boolean(loadingPreview || stagingBusy || navigation.opening);
  const canPreview = staged.length > 0 && effectiveReady && !busy;
  const undoSnapshot = stageHistory?.undo_snapshot_id;
  const redoSnapshot = stageHistory?.redo_snapshot_id;
  const blockedPaths = new Map(blockedWarnings.map(({ path, reason }) => [path, reason]));
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));
  const verificationSites = activeBlockers.flatMap(({ siteId, files }) => {
    const verification = verificationForSite(siteId);
    const name = siteNames.get(siteId);
    return verification && name ? [{ siteId, name, verification, files }] : [];
  });
  const awaitingVerification = new Set(activeBlockers.flatMap(({ files }) => files.map((file) => file.file_id)));
  const readyPreview = effectiveReady && preview?.db_entry_count_stable ? preview : null;
  const groups = readyPreview?.review_groups ?? [];
  const groupedIds = new Set(groups.flatMap((group) => group.staged_file_ids));
  const ungrouped = staged.filter((file) => !groupedIds.has(file.file_id));

  function inspectFile(file: DuplicateFile) {
    const body = results.current?.closest(".atlas-analysis-body");
    void navigation.show({ file, position: { file_id: file.file_id, scroll_top: body?.scrollTop ?? 0 } });
  }

  function removeFile(file: DuplicateFile, button: HTMLButtonElement) {
    button.focus({ preventScroll: true });
    removalFocus.current = { id: file.file_id, button };
    onRemove(file.path);
  }

  async function stepHistory(direction: StageHistoryDirection) {
    const target = direction === "undo" ? undoSnapshot : redoSnapshot;
    if (!target || busy) return;
    (direction === "undo" ? undoButton : redoButton).current?.focus({ preventScroll: true });
    setHistoryAnnouncement("");
    if (await onHistoryStep({ direction, expected_snapshot_id: stageHistory.snapshot_id, target_snapshot_id: target })) {
      setHistoryAnnouncement(direction === "undo" ? "Staging change undone." : "Staging change redone.");
    }
  }

  function handleHistoryKeys(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || event.nativeEvent.isComposing) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    const key = event.key.toLowerCase();
    if (key === "z" || (key === "y" && event.ctrlKey && !event.shiftKey)) {
      event.preventDefault();
      void stepHistory(key === "y" || event.shiftKey ? "redo" : "undo");
    }
  }

  return (
    <AnalysisDialog
      title="Cleanup review"
      className="atlas-cleanup-review"
      drawer
      onClose={navigation.close}
      onKeyDown={handleHistoryKeys}
      footer={
        <>
          {navigation.error && <p className="atlas-review-inspect-error" role="alert">{navigation.error}</p>}
          {navigation.opening && <span role="status">Opening file…</span>}
          {(undoSnapshot || redoSnapshot) ? (
            <div ref={trackHistoryFocus} className="atlas-review-history" role="group" aria-label="Staging history">
              <button ref={undoButton} type="button" aria-label="Undo staging change"
                aria-keyshortcuts="Meta+Z Control+Z"
                aria-disabled={busy || !undoSnapshot || undefined} onClick={() => void stepHistory("undo")}>Undo</button>
              <button ref={redoButton} type="button" aria-label="Redo staging change"
                aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y"
                aria-disabled={busy || !redoSnapshot || undefined} onClick={() => void stepHistory("redo")}>Redo</button>
            </div>
          ) : !navigation.opening && <span>Preview only</span>}
          <span className="atlas-scan-announcement" role="status">{historyAnnouncement}</span>
          <button
            type="button" className="atlas-analysis-primary" ref={previewButton}
            onClick={canPreview ? onPreview : undefined} aria-disabled={!canPreview || undefined}
            aria-describedby={!effectiveReady || staged.length === 0 ? blockedMessageId : undefined}
          >
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
          <p id={blockedMessageId} role="status">No copies staged. Select a folder or file with verified duplicates to start a review.</p>
        )}
        {staged.length > 0 && effectiveReady && !preview && !loadingPreview && !error && (
          <p role="status">Preview cleanup to see which copies would remain.</p>
        )}
        {staged.length > 0 && pending > 0 && (
          <p id={blockedMessageId} className="atlas-analysis-warning" role="status">
            {formatCount(pending)} staged {pending === 1 ? "hash is" : "hashes are"} pending.
            {!verificationSites.length && " Finish hashing or remove the affected copies."}
          </p>
        )}
        {staged.length > 0 && pending === 0 && !effectiveReady && (
          <div id={blockedMessageId} className="atlas-analysis-warning" role="status">
            <strong>Cleanup suspended</strong>
            {!verificationSites.length && <p>Review the marked copies or remove them from this cleanup.</p>}
          </div>
        )}
        {verificationSites.length > 0 && (
          <section className="atlas-review-verification" aria-labelledby={verificationHeadingId}>
            <h3 id={verificationHeadingId}>Verification needed</h3>
            <ul className="atlas-review-verification-list">
              {verificationSites.map((site) => (
                <ReviewVerificationSite key={site.siteId} {...site} busy={busy} onScanSite={onScanSite} focusTarget={previewButton} />
              ))}
            </ul>
          </section>
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
                      disabled={busy} onInspect={inspectFile} onRemove={removeFile} />
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
              const waiting = awaitingVerification.has(file.file_id);
              const warningLabel = waiting && (!warning || warning === "not_duplicate")
                ? "Verification pending" : warning ? warningLabels[warning] : undefined;
              return (
                <ReviewFile
                  key={file.file_id} file={file} site={siteNames.get(file.site_id)} warning={warningLabel}
                  disabled={busy} onInspect={warning === "not_tracked" ? undefined : inspectFile} onRemove={removeFile}
                />
              );
            })}
          </ul>
        )}
      </div>
    </AnalysisDialog>
  );
}
