import { useCallback, useEffect, useRef, useState } from "react";
import { fileName, formatBytes, formatCount } from "../../lib/format";
import { getFileContentMatches } from "../../lib/tauri";
import type { FileContentMatch } from "../../lib/types";
import { CheckIcon, OpenInIcon } from "../../management/Icons";
import { AnalysisDialog } from "./AnalysisDialog";
import { AnalysisError, AnalysisPageControls, VerificationNote } from "./AnalysisPageControls";
import { useAnalysisPage } from "./useAnalysisPage";
import "./file-copies.css";

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
  onJump: (match: FileContentMatch, signal: AbortSignal) => Promise<string | null>;
  onClose: () => void;
}

function CopyLocation({ label, file }: { label: string; file: FileLocation }) {
  return (
    <section className="atlas-copy-location" aria-label={label}>
      <p>{label}</p>
      <h3>{file.name}</h3>
      <div className="atlas-copy-location-meta">
        <span>{file.site}</span>
        <span>{formatBytes(file.size)}</span>
      </div>
      <code>{file.path}</code>
    </section>
  );
}

function containingFolder(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-2);
}

export function FileCopiesDialog({ workspaceName, siteId, source, onJump, onClose }: FileCopiesDialogProps) {
  const path = source.path;
  const load = useCallback(
    (offset: number) => getFileContentMatches(siteId, path, offset, COPY_PAGE_SIZE, workspaceName),
    [workspaceName, siteId, path],
  );
  const { page, loading, error, goTo, retry } = useAnalysisPage(load);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const matches = page?.matches.filter((match) => !match.is_current) ?? [];
  const selected = matches.find((match) => match.file_id === selectedId) ?? matches[0];
  const copyCount = page?.status === "ready" ? Math.max(0, page.total_matches - 1) : 0;

  useEffect(() => () => attempt.current?.abort(), []);

  function close() {
    attempt.current?.abort();
    onClose();
  }

  async function showSelected() {
    if (!selected || loading || error || attempt.current) return;
    const request = new AbortController();
    attempt.current = request;
    setOpening(true);
    setNavigationError(null);
    try {
      const failure = await onJump(selected, request.signal);
      if (request.signal.aborted) return;
      if (failure === null) onClose();
      else setNavigationError(failure);
    } finally {
      attempt.current = null;
      if (!request.signal.aborted) setOpening(false);
    }
  }

  return (
    <AnalysisDialog
      title="Exact copies"
      onClose={close}
      footer={selected && (
        <>
          {navigationError && <p className="atlas-copy-error" role="alert">{navigationError}</p>}
          <button
            className="atlas-analysis-primary atlas-copy-jump" type="button"
            aria-disabled={opening || loading || Boolean(error) || undefined} aria-busy={opening || undefined}
            onClick={() => void showSelected()}
          >
            {opening ? "Opening copy…" : "Show in Atlas"} <OpenInIcon />
          </button>
        </>
      )}
    >
      <section className="atlas-analysis-results" aria-busy={loading}>
        <div className="atlas-copy-comparison" data-comparing={selected ? "" : undefined}>
          <CopyLocation label="Selected file" file={source} />
          {selected && (
            <CopyLocation
              label="Matching copy"
              file={{ name: fileName(selected.path), site: selected.site_name, path: selected.path, size: selected.size_bytes }}
            />
          )}
        </div>
        {loading && !page && <p role="status">Finding exact copies…</p>}
        {error && <AnalysisError error={error} retry={retry} />}
        {page && (
          <>
            {page.status === "not_hashed" && <p role="status">Scan this site to hash the file and find copies.</p>}
            {page.status === "needs_verification" && <p role="status">This file needs verification before all copies can be shown.</p>}
            {page.status === "ready" && (
              <p role="status">
                {copyCount > 0
                  ? `${formatCount(copyCount)} verified ${copyCount === 1 ? "copy" : "copies"}`
                  : "No other verified copies were found."}
              </p>
            )}
            <VerificationNote pending={page.workspace_pending_hash_count} incomplete={page.workspace_incomplete_site_count} />
            {matches.length > 0 && (
              <ul className="atlas-analysis-list atlas-copy-choices" aria-label="Matching files">
                {matches.map((match) => {
                  const name = fileName(match.path);
                  const folder = containingFolder(match.path);
                  return (
                    <li key={match.file_id}>
                      <button
                        className="atlas-analysis-row" type="button"
                        aria-pressed={selected?.file_id === match.file_id}
                        aria-description={match.path}
                        disabled={opening || loading}
                        onClick={() => {
                          setSelectedId(match.file_id);
                          setNavigationError(null);
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
                page={page} loading={loading || opening} pageNumbers
                goTo={(offset) => {
                  setNavigationError(null);
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
