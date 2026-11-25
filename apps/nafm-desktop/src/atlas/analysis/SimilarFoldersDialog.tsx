import { useCallback, useId, useRef, useState } from "react";
import { fileName, formatBytes, formatCount, formatHealth } from "../../lib/format";
import { findSimilarFolders } from "../../lib/tauri";
import type { FolderContentSummary, FolderSimilarityMatch, FolderSimilarityPage, StorageNode } from "../../lib/types";
import { CheckIcon } from "../../management/Icons";
import type { ScanSite, SiteVerification } from "../siteVerification";
import { VerificationScanButton } from "../VerificationScanButton";
import { AnalysisLocation, AnalysisNavigationFooter, useComparisonScroll } from "./AnalysisComparison";
import { AnalysisDialog } from "./AnalysisDialog";
import { AnalysisError, AnalysisPageControls, VerificationNote } from "./AnalysisPageControls";
import { useAnalysisNavigation } from "./useAnalysisNavigation";
import { useAnalysisPage, type AnalysisPosition } from "./useAnalysisPage";
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
  const verificationNoteId = useId();
  const [scanError, setScanError] = useState<string | null>(null);
  const load = useCallback((offset: number) => findSimilarFolders({
    workspace_name: workspaceName, site_id: siteId, node_id: nodeId, offset, limit: MATCH_PAGE_SIZE,
  }), [workspaceName, siteId, nodeId]);
  const { page, loading, error, goTo, retry } = useAnalysisPage(load, contentRevision, position?.page.offset,
    position?.revision === contentRevision ? position.page : undefined);
  const [selectedKey, setSelectedKey] = useState<string | null>(position?.selected_id ?? null);
  const { results, showButton, readScroll } = useComparisonScroll(position?.scroll_top, Boolean(page && !loading && !error));
  const navigation = useAnalysisNavigation(onJump, onClose, (match) => {
    if (page) onShown(match, { page, selected_id: folderKey(match), scroll_top: readScroll(), revision: contentRevision });
  });
  const busy = loading || Boolean(error) || navigation.opening;
  const selectedMatch = page?.matches.find((match) => folderKey(match) === selectedKey);
  const selected = selectedMatch ?? page?.matches[0];
  const matchChanged = selectedKey !== null && page && !loading && !error && !selectedMatch;
  const source = page?.source;
  const emptyFolder = source?.inventory_ready && source.file_count === 0;
  const needsVerification = source?.distinct_content_count === 0 && (!source.inventory_ready || source.pending_hash_count > 0);
  const scan = needsVerification ? verification?.action : undefined;
  const scanFailure = scan && verification?.tone !== "active" ? scanError ?? verification?.failure : null;

  function browse(offset: number) {
    setSelectedKey(null);
    navigation.clearError();
    goTo(offset);
  }

  function choose(key: string) {
    setSelectedKey(key);
    navigation.clearError();
  }

  return (
    <AnalysisDialog
      title="Similar folders"
      closeButtonRef={closeButton}
      onClose={navigation.close}
      footer={selected || navigation.opening || navigation.error ? (
        <AnalysisNavigationFooter
          error={navigation.error} opening={navigation.opening} disabled={loading || Boolean(error)}
          pendingLabel="Opening folder…" buttonRef={showButton} onShow={selected ? () => void navigation.show(selected) : undefined}
        />
      ) : scan && (
        <VerificationScanButton action={{ ...scan, disabled: scan.disabled || busy }} onScanSite={onScanSite}
          onScanError={setScanError}
          focusTarget={closeButton} describedBy={verificationNoteId} className="atlas-analysis-primary atlas-analysis-reveal-button" />
      )}
    >
      <section className="atlas-analysis-results" ref={results} aria-busy={loading}>
        {page && selected && (
          <label className="atlas-folder-match-select">
            Compare with
            <select
              aria-disabled={busy || undefined} value={folderKey(selected)}
              onPointerDown={busy ? (event) => event.preventDefault() : undefined}
              onKeyDown={busy ? (event) => { if (event.key !== "Tab" && event.key !== "Escape") event.preventDefault(); } : undefined}
              onChange={busy ? undefined : (event) => choose(event.currentTarget.value)}
            >
              {page.matches.map((match) => (
                <option key={folderKey(match)} value={folderKey(match)}>
                  {fileName(match.folder.path)} · {match.folder.site_name} · {percent(match.similarity, match.partial)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="atlas-analysis-comparison atlas-folder-comparison" data-comparing={selected ? "" : undefined}>
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
          {selected && (
            <AnalysisLocation
              label="Matching folder" name={fileName(selected.folder.path)} site={selected.folder.site_name}
              path={selected.folder.path} detail={formatBytes(selected.folder.distinct_bytes)}
            >
              <FolderEvidence folder={selected.folder} />
              <Coverage
                label={selected.folder.distinct_bytes ? "Size also in selected folder" : "Content also in selected folder"}
                value={selected.target_coverage} partial={selected.partial} allMatched={selected.target_only_count === 0}
              />
            </AnalysisLocation>
          )}
        </div>
        {loading && !page && <p role="status">Comparing indexed contents…</p>}
        {loading && page && <p role="status">Refreshing similar folders…</p>}
        {error && <AnalysisError error={error} retry={retry} />}
        {matchChanged && <p role="status">The comparison results changed.</p>}
        {page && (
          <>
            <VerificationNote pending={page.workspace_pending_hash_count} incomplete={page.workspace_incomplete_site_count} />
            {selected ? (
              <section className="atlas-folder-overlap" aria-label="Folder comparison details">
                <h3>Verified content overlap</h3>
                <ContentBreakdown match={selected} />
                {selected.partial && <p role="status" className="atlas-analysis-warning">This comparison covers the verified portions of both folders.</p>}
              </section>
            ) : (
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
              <button className="atlas-folder-refresh" type="button" aria-disabled={busy || undefined} onClick={busy ? undefined : () => {
                navigation.clearError();
                retry();
              }}>Refresh results</button>
            </div>
            {page.matches.length > 0 && (
              <ul className="atlas-analysis-list atlas-analysis-choices atlas-folder-match-list" aria-label="Matching folders">
                {page.matches.map((match) => {
                  const key = folderKey(match);
                  const same = match.identical_content && !match.partial;
                  const unit = page.source.distinct_bytes || match.folder.distinct_bytes ? "size" : "count";
                  return (
                    <li key={key}>
                      <button
                        className="atlas-analysis-row" type="button" aria-disabled={busy || undefined}
                        aria-pressed={selected === match} aria-description={match.folder.path}
                        onClick={busy ? undefined : () => choose(key)}
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
            {page.total_matches > page.limit && <AnalysisPageControls page={page} loading={busy} goTo={browse} />}
            <time className="atlas-analysis-timestamp" dateTime={page.generated_at}>Snapshot {new Date(page.generated_at).toLocaleString()}</time>
          </>
        )}
      </section>
    </AnalysisDialog>
  );
}
