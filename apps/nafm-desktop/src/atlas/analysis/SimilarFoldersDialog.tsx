import { useCallback, useId, useRef, useState } from "react";
import { fileName, formatBytes, formatCount, formatHealth } from "../../lib/format";
import { findSimilarFolders } from "../../lib/tauri";
import type { FolderContentSummary, FolderSimilarityMatch, FolderSimilarityPage, StorageNode } from "../../lib/types";
import { CheckIcon } from "../../management/Icons";
import type { ScanSite, SiteVerification } from "../siteVerification";
import { VerificationScanButton } from "../VerificationScanButton";
import { AnalysisLocation, AnalysisNavigationFooter, ComparisonPicker, useComparisonScroll, useRemovedComparisonFocus } from "./AnalysisComparison";
import { AnalysisDialog } from "./AnalysisDialog";
import { AnalysisError, AnalysisPageControls, VerificationNote } from "./AnalysisPageControls";
import { useAnalysisNavigation } from "./useAnalysisNavigation";
import { useAnalysisPage, type AnalysisPosition } from "./useAnalysisPage";
import { useAnalysisSelection } from "./useAnalysisSelection";
import "./folder-comparison.css";

const MATCH_PAGE_SIZE = 10;

interface SimilarFoldersDialogProps {
  workspaceName: string;
  siteId: string;
  siteName: string;
  node: StorageNode;
  contentRevision: number;
  position: AnalysisPosition<FolderSimilarityPage> | null;
  verification?: SiteVerification;
  onScanSite: ScanSite;
  onJump: (match: FolderSimilarityMatch, signal: AbortSignal) => Promise<string | null>;
  onClose: () => void;
  onShown: (match: FolderSimilarityMatch, position: AnalysisPosition<FolderSimilarityPage>) => void;
}

function folderKey({ folder }: FolderSimilarityMatch) {
  return JSON.stringify([folder.site_id, folder.node_id]);
}

function percent(value: number, partial: boolean) {
  return `${partial ? "≈" : ""}${formatHealth(value)}%`;
}

function FolderEvidence({ folder }: { folder: FolderContentSummary }) {
  return (
    <p className="atlas-folder-evidence">
      {formatCount(folder.verified_file_count)} of {formatCount(folder.file_count)} files verified
      {folder.extra_copy_count > 0 && (
        <> · {formatCount(folder.extra_copy_count)} {folder.extra_copy_count === 1 ? "extra copy" : "extra copies"}</>
      )}
    </p>
  );
}

function Coverage({ label, value, partial, allMatched }: { label: string; value: number; partial: boolean; allMatched: boolean }) {
  return (
    <div className="atlas-folder-coverage">
      <div>
        <span>{label}</span>
        <strong>
          {percent(value, partial)}
          {!partial && allMatched && value === 100 && <CheckIcon aria-hidden={false} role="img" aria-label="Full coverage" />}
        </strong>
      </div>
      <div className="atlas-folder-coverage-track" aria-hidden="true">
        <span style={{ width: Math.min(100, Math.max(0, value)) + "%" }} />
      </div>
    </div>
  );
}

function ContentBreakdown({ match }: { match: FolderSimilarityMatch }) {
  const groups = [
    ["Shared content", match.shared_content_count, match.shared_bytes],
    ["Only in selected folder", match.source_only_count, match.source_only_bytes],
    ["Only in match", match.target_only_count, match.target_only_bytes],
  ] as const;

  return (
    <dl className="atlas-analysis-facts atlas-folder-breakdown">
      {groups.map(([label, count, bytes]) => (
        <div key={label}><dt>{label}</dt><dd>{formatCount(count)} · {formatBytes(bytes)}</dd></div>
      ))}
    </dl>
  );
}

export function SimilarFoldersDialog({ workspaceName, siteId, siteName, node, contentRevision, position, verification, onScanSite, onJump, onClose, onShown }: SimilarFoldersDialogProps) {
  const nodeId = node.id;
  const closeButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const verificationNoteId = useId();
  const availabilityNoteId = useId();
  const [scanError, setScanError] = useState<string | null>(null);
  const load = useCallback((offset: number) => findSimilarFolders({
    workspace_name: workspaceName, site_id: siteId, node_id: nodeId, offset, limit: MATCH_PAGE_SIZE,
  }), [workspaceName, siteId, nodeId]);
  const { page, pageSequence, loading, error, goTo, retry } = useAnalysisPage(load, contentRevision, position?.page.offset,
    position?.revision === contentRevision ? position.page : undefined);
  const matches = page?.matches ?? [];
  const initialMatch = position?.page.matches.find((match) => folderKey(match) === position.selected_id);
  const { selected, unavailable: missingMatch, choose } = useAnalysisSelection(matches, folderKey, pageSequence, !loading && !error, initialMatch);
  const displayedMatch = selected ?? missingMatch;
  const unavailable = page && missingMatch;
  const { results, showButton, readScroll } = useComparisonScroll(position?.scroll_top, Boolean(page && !loading && !error));
  const recoverRemovedFocus = useRemovedComparisonFocus(results, closeButton);
  const navigation = useAnalysisNavigation(onJump, onClose, (match) => {
    if (page) onShown(match, { page, selected_id: folderKey(match), scroll_top: readScroll(), revision: contentRevision });
  });
  const busy = loading || Boolean(error) || navigation.opening;
  const selectedKey = selected && folderKey(selected);
  const source = page?.source;
  const emptyFolder = source?.inventory_ready && source.file_count === 0;
  const needsVerification = source?.distinct_content_count === 0 && (!source.inventory_ready || source.pending_hash_count > 0);
  const scan = needsVerification ? verification?.action : undefined;
  const scanFailure = scan && verification?.tone !== "active" ? scanError ?? verification?.failure : null;
  const showNavigation = displayedMatch || navigation.opening || navigation.error;
  const verificationAction = !selected && !navigation.opening && scan;

  function browse(offset: number) {
    navigation.clearError();
    goTo(offset);
  }

  function chooseMatch(match: FolderSimilarityMatch) {
    choose(match);
    navigation.clearError();
  }

  return (
    <AnalysisDialog
      title="Similar folders"
      closeButtonRef={closeButton}
      onClose={navigation.close}
      footer={(showNavigation || verificationAction) && (
        <>
          {showNavigation && (
            <AnalysisNavigationFooter
              error={navigation.error} opening={navigation.opening} disabled={loading || Boolean(error)}
              showWhenUnavailable={Boolean(missingMatch)} describedBy={unavailable ? availabilityNoteId : undefined}
              pendingLabel="Opening folder…" buttonRef={showButton} onShow={selected ? () => void navigation.show(selected) : undefined}
            />
          )}
          {verificationAction && (
            <VerificationScanButton action={{ ...verificationAction, disabled: verificationAction.disabled || busy }} onScanSite={onScanSite}
              onScanError={setScanError} focusTarget={closeButton} describedBy={verificationNoteId}
              className="atlas-analysis-primary atlas-analysis-reveal-button" />
          )}
        </>
      )}
    >
      <section className="atlas-analysis-results" ref={results} aria-busy={loading}>
        {page && <ComparisonPicker
          matches={matches} selected={selected} unavailable={missingMatch} busy={busy} identify={folderKey}
          label={(match, missing) => [fileName(match.folder.path), match.folder.site_name,
            !missing && percent(match.similarity, match.partial)].filter(Boolean).join(" · ")}
          onChoose={chooseMatch} focusRef={recoverRemovedFocus}
        />}
        <div className="atlas-analysis-comparison atlas-folder-comparison" data-comparing={displayedMatch ? "" : undefined}>
          <AnalysisLocation
            label="Selected folder" name={node.name} site={siteName} path={source?.path ?? node.path}
            detail={source ? formatBytes(source.distinct_bytes) : undefined}
          >
            {source && <FolderEvidence folder={source} />}
            {selected && (
              <Coverage
                label={source?.distinct_bytes ? "Size also in match" : "Content also in match"} value={selected.source_coverage}
                partial={selected.partial} allMatched={selected.source_only_count === 0}
              />
            )}
          </AnalysisLocation>
          {displayedMatch && (
            <AnalysisLocation
              label="Matching folder" name={fileName(displayedMatch.folder.path)} site={displayedMatch.folder.site_name}
              path={displayedMatch.folder.path} detail={selected ? formatBytes(selected.folder.distinct_bytes) : undefined}
              unavailable={Boolean(unavailable)}
            >
              {selected && (
                <>
                  <FolderEvidence folder={selected.folder} />
                  <Coverage
                    label={selected.folder.distinct_bytes ? "Size also in selected folder" : "Content also in selected folder"}
                    value={selected.target_coverage} partial={selected.partial} allMatched={selected.target_only_count === 0}
                  />
                </>
              )}
              <p id={availabilityNoteId} className="atlas-analysis-warning atlas-analysis-availability" role="status">
                {unavailable ? "The selected folder is unavailable in the current results." : ""}
              </p>
            </AnalysisLocation>
          )}
        </div>
        {loading && !page && <p role="status">Comparing indexed contents…</p>}
        {loading && page && <p role="status">Refreshing similar folders…</p>}
        {error && <AnalysisError error={error} retry={retry} focusTarget={page ? refreshButton : closeButton} />}
        {page && (
          <>
            <VerificationNote pending={page.workspace_pending_hash_count} incomplete={page.workspace_incomplete_site_count} />
            {selected ? (
              <section className="atlas-folder-overlap" aria-label="Folder comparison details">
                <h3>Verified content overlap</h3>
                <ContentBreakdown match={selected} />
                {selected.partial && <p role="status" className="atlas-analysis-warning">This comparison covers the verified portions of both folders.</p>}
              </section>
            ) : (!unavailable || needsVerification) && (
              <p id={verificationNoteId} role="status">{page.source.distinct_content_count > 0
                ? "No other indexed folders share verified content."
                : emptyFolder ? "This folder has no files to compare."
                : needsVerification && verification?.tone === "active" ? "Results update as files are verified."
                : scan ? "Verify files on this site to find similar folders." : "No verified files in this folder to compare."}
              </p>
            )}
            {scanFailure && <p className="atlas-analysis-warning" role="alert">{scanFailure}</p>}
            <div className="atlas-analysis-meta">
              {page.total_matches > 0 && <span role="status">{formatCount(page.total_matches)} {page.total_matches === 1 ? "match" : "matches"}</span>}
              <button className="atlas-folder-refresh" type="button" ref={refreshButton} aria-disabled={busy || undefined} onClick={busy ? undefined : () => {
                navigation.clearError();
                retry();
              }}>Refresh results</button>
            </div>
            {matches.length > 0 && (
              <ul className="atlas-analysis-list atlas-analysis-choices" aria-label="Matching folders">
                {matches.map((match) => {
                  const key = folderKey(match);
                  const same = match.identical_content && !match.partial;
                  const unit = page.source.distinct_bytes || match.folder.distinct_bytes ? "size" : "count";
                  return (
                    <li key={key}>
                      <button
                        className="atlas-analysis-row" type="button" ref={recoverRemovedFocus} data-comparison-choice aria-disabled={busy || undefined}
                        aria-pressed={selectedKey === key} aria-description={match.folder.path}
                        onClick={busy ? undefined : () => chooseMatch(match)}
                      >
                        <span className="atlas-analysis-location">
                          <strong>{match.folder.site_name}</strong><span>{fileName(match.folder.path)}</span>
                        </span>
                        <span className="atlas-analysis-score">
                          <strong>{percent(match.similarity, match.partial)}</strong>
                          <small>{same ? "Same verified content" : match.partial ? "Partial verification" : `Similarity by ${unit}`}</small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {page.total_matches > page.limit && <AnalysisPageControls page={page} loading={busy} goTo={browse} focusRef={recoverRemovedFocus} />}
            <time className="atlas-analysis-timestamp" dateTime={page.generated_at}>Snapshot {new Date(page.generated_at).toLocaleString()}</time>
          </>
        )}
      </section>
    </AnalysisDialog>
  );
}
