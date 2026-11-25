import { useCallback, useId, useRef, useState } from "react";
import { fileName, formatBytes, formatCount } from "../../lib/format";
import { getFileContentMatches } from "../../lib/tauri";
import type { FileContentMatch, FileContentMatchesPage } from "../../lib/types";
import { CheckIcon } from "../../management/Icons";
import type { ScanSite, SiteVerification } from "../siteVerification";
import { VerificationScanButton } from "../VerificationScanButton";
import { AnalysisLocation, AnalysisNavigationFooter, useComparisonScroll } from "./AnalysisComparison";
import { AnalysisDialog } from "./AnalysisDialog";
import { AnalysisError, AnalysisPageControls, VerificationNote } from "./AnalysisPageControls";
import { useAnalysisPage, type AnalysisPosition } from "./useAnalysisPage";
import { useAnalysisNavigation } from "./useAnalysisNavigation";

const COPY_PAGE_SIZE = 10;

interface FileLocation {
  name: string;
  site: string;
  path: string;
  size: number;
}

interface FileCopiesDialogProps {
  workspaceName: string;
  siteId: string;
  source: FileLocation;
  contentRevision: number;
  position: AnalysisPosition<FileContentMatchesPage> | null;
  verification?: SiteVerification;
  onScanSite: ScanSite;
  onJump: (match: FileContentMatch, signal: AbortSignal) => Promise<string | null>;
  onClose: () => void;
  onShown: (match: FileContentMatch, position: AnalysisPosition<FileContentMatchesPage>) => void;
}

function containingFolder(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-2);
}

export function FileCopiesDialog({ workspaceName, siteId, source, contentRevision, position, verification, onScanSite, onJump, onClose, onShown }: FileCopiesDialogProps) {
  const path = source.path;
  const closeButton = useRef<HTMLButtonElement>(null);
  const verificationNoteId = useId();
  const [scanError, setScanError] = useState<string | null>(null);
  const load = useCallback(
    (offset: number) => getFileContentMatches(siteId, path, offset, COPY_PAGE_SIZE, workspaceName),
    [workspaceName, siteId, path],
  );
  const { page, loading, error, goTo, retry } = useAnalysisPage(load, contentRevision, position?.page.offset,
    position?.revision === contentRevision ? position.page : undefined);
  const [selectedId, setSelectedId] = useState<string | null>(position?.selected_id ?? null);
  const { results, showButton, readScroll } = useComparisonScroll(position?.scroll_top, Boolean(page && !loading && !error));
  const navigation = useAnalysisNavigation(onJump, onClose, (match) => {
    if (page) onShown(match, { page, selected_id: match.file_id, scroll_top: readScroll(), revision: contentRevision });
  }, contentRevision);
  const busy = loading || Boolean(error) || navigation.opening;
  const matches = page?.matches.filter((match) => !match.is_current) ?? [];
  const selectedMatch = matches.find((match) => match.file_id === selectedId);
  const selected = selectedMatch ?? matches[0];
  const matchChanged = position && page && position.revision !== contentRevision && !loading && !error
    && (page.offset === position.page.offset || page.total_matches <= position.page.offset)
    && selectedId === position.selected_id && !selectedMatch;
  const copyCount = page?.status === "ready" ? Math.max(0, page.total_matches - 1) : 0;
  const needsVerification = page && page.status !== "ready";
  const scan = needsVerification ? verification?.action : undefined;
  const scanFailure = needsVerification && verification?.tone !== "active" ? scanError ?? verification?.failure : null;

  return (
    <AnalysisDialog
      title="Exact copies"
      closeButtonRef={closeButton}
      onClose={navigation.close}
      footer={selected ? (
        <AnalysisNavigationFooter
          error={navigation.error} opening={navigation.opening} disabled={loading || Boolean(error)}
          pendingLabel="Opening copy…" buttonRef={showButton} onShow={() => void navigation.show(selected)}
        />
      ) : scan && (
        <VerificationScanButton action={{ ...scan, disabled: scan.disabled || busy }} onScanSite={onScanSite}
          onScanError={setScanError}
          focusTarget={closeButton} describedBy={verificationNoteId} className="atlas-analysis-primary atlas-analysis-reveal-button" />
      )}
    >
      <section className="atlas-analysis-results" ref={results} aria-busy={loading}>
        <div className="atlas-analysis-comparison" data-comparing={selected ? "" : undefined}>
          <AnalysisLocation label="Selected file" name={source.name} site={source.site} path={source.path} detail={formatBytes(source.size)} />
          {selected && (
            <AnalysisLocation
              label="Matching copy" name={fileName(selected.path)} site={selected.site_name}
              path={selected.path} detail={formatBytes(selected.size_bytes)}
            />
          )}
        </div>
        {loading && !page && <p role="status">Finding exact copies…</p>}
        {loading && page && <p role="status">Refreshing exact copies…</p>}
        {error && <AnalysisError error={error} retry={retry} />}
        {matchChanged && <p role="status">The comparison results changed.</p>}
        {page && (
          <>
            {page.status !== "ready" && (
              <p id={verificationNoteId} role="status">{verification?.tone === "active" ? "Results update after verification finishes."
                : page.status === "not_hashed" ? "Scan this site to hash the file and find copies."
                : "Finish verifying this site to see all copies."}</p>
            )}
            {scanFailure && <p className="atlas-analysis-warning" role="alert">{scanFailure}</p>}
            {page.status === "ready" && (
              <p role="status">
                {copyCount > 0
                  ? `${formatCount(copyCount)} verified ${copyCount === 1 ? "copy" : "copies"}`
                  : "No other verified copies were found."}
              </p>
            )}
            <VerificationNote pending={page.workspace_pending_hash_count} incomplete={page.workspace_incomplete_site_count} />
            {matches.length > 0 && (
              <ul className="atlas-analysis-list atlas-analysis-choices" aria-label="Matching files">
                {matches.map((match) => {
                  const name = fileName(match.path);
                  const folder = containingFolder(match.path);
                  return (
                    <li key={match.file_id}>
                      <button
                        className="atlas-analysis-row" type="button"
                        aria-pressed={selected?.file_id === match.file_id}
                        aria-description={match.path}
                        aria-disabled={busy || undefined}
                        onClick={busy ? undefined : () => {
                          setSelectedId(match.file_id);
                          navigation.clearError();
                        }}
                      >
                        <span className="atlas-analysis-location">
                          <strong>{match.site_name}</strong>
                          {folder && <span>{folder}</span>}
                          {name !== source.name && <span>{name}</span>}
                        </span>
                        {selected?.file_id === match.file_id && <CheckIcon />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {page.total_matches > page.limit && (
              <AnalysisPageControls
                page={page} loading={busy} pageNumbers
                goTo={(offset) => {
                  navigation.clearError();
                  goTo(offset);
                }}
              />
            )}
          </>
        )}
      </section>
    </AnalysisDialog>
  );
}
