import { useCallback, useState } from "react";
import { fileName, formatBytes, formatCount } from "../../lib/format";
import { getFileContentMatches } from "../../lib/tauri";
import type { FileContentMatch } from "../../lib/types";
import { CheckIcon } from "../../management/Icons";
import { AnalysisLocation, AnalysisNavigationFooter } from "./AnalysisComparison";
import { AnalysisDialog } from "./AnalysisDialog";
import { AnalysisError, AnalysisPageControls, VerificationNote } from "./AnalysisPageControls";
import { useAnalysisPage } from "./useAnalysisPage";
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
  onJump: (match: FileContentMatch, signal: AbortSignal) => Promise<string | null>;
  onClose: () => void;
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
  const navigation = useAnalysisNavigation(onJump, onClose);
  const matches = page?.matches.filter((match) => !match.is_current) ?? [];
  const selected = matches.find((match) => match.file_id === selectedId) ?? matches[0];
  const copyCount = page?.status === "ready" ? Math.max(0, page.total_matches - 1) : 0;

  return (
    <AnalysisDialog
      title="Exact copies"
      onClose={navigation.close}
      footer={selected && (
        <AnalysisNavigationFooter
          error={navigation.error} opening={navigation.opening} disabled={loading || Boolean(error)}
          pendingLabel="Opening copy…" onShow={() => void navigation.show(selected)}
        />
      )}
    >
      <section className="atlas-analysis-results" aria-busy={loading}>
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
                        disabled={navigation.opening || loading}
                        onClick={() => {
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
                page={page} loading={loading || navigation.opening} pageNumbers
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
