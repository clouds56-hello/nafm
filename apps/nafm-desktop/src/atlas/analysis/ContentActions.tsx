import { useCallback, useState } from "react";
import { formatBytes, formatCount, formatHealth } from "../../lib/format";
import { findSimilarFolders } from "../../lib/tauri";
import type {
  FileContentMatch,
  FolderSimilarityMatch,
  HealthMetric,
  StorageNode,
} from "../../lib/types";
import { AnalysisDialog } from "./AnalysisDialog";
import { AnalysisError, AnalysisPageControls, VerificationNote } from "./AnalysisPageControls";
import { FileCopiesDialog } from "./FileCopiesDialog";
import { useAnalysisPage } from "./useAnalysisPage";

const MATCH_PAGE_SIZE = 10;

interface ContentActionsProps {
  workspaceName: string;
  siteId: string;
  siteName: string;
  contentRevision: number;
  node: StorageNode;
  metric: HealthMetric;
  staged: boolean;
  stagingBusy: boolean;
  sourceAnalysisReady?: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onJumpDuplicate: (match: FileContentMatch, signal: AbortSignal) => Promise<string | null>;
}

type AnalysisKind = "copies" | "similarity";

export function ContentActions(props: ContentActionsProps) {
  return <ContentActionsView key={JSON.stringify([props.workspaceName, props.siteId, props.node.id])} {...props} />;
}

function ContentActionsView({
  workspaceName,
  siteId,
  siteName,
  contentRevision,
  node,
  metric,
  staged,
  stagingBusy,
  sourceAnalysisReady = true,
  onStage,
  onUnstage,
  onJumpDuplicate,
}: ContentActionsProps) {
  const [view, setView] = useState<AnalysisKind | null>(null);
  const path = node.path;
  const canCompare = node.kind === "directory" || node.kind === "local_root" || node.kind === "smb_root";
  const canCheckCopies = node.kind === "file" && path !== null;
  const canShowStage = metric === "space_health" && path !== null && (canCompare || canCheckCopies);
  const analysisReady = sourceAnalysisReady && node.pending_hash_count === 0;
  const canStage = analysisReady && node.duplicate_bytes > 0;

  if (!canCompare && !canCheckCopies) return null;

  return (
    <>
      <div className="atlas-content-actions" role="group" aria-label="Content actions">
        {canCompare && (
          <button type="button" onClick={() => setView("similarity")} aria-haspopup="dialog">
            Similar folders <span aria-hidden="true">↗</span>
          </button>
        )}
        {canCheckCopies && (
          <button type="button" onClick={() => setView("copies")} aria-haspopup="dialog">
            Exact copies <span aria-hidden="true">↗</span>
          </button>
        )}
        {canShowStage && (
          <button
            type="button"
            className="atlas-stage-selection"
            disabled={stagingBusy || (!staged && !canStage)}
            onClick={staged ? onUnstage : onStage}
            title={!staged && !canStage
              ? analysisReady ? "No verified duplicate data is available to stage" : "Verify hashes before staging"
              : undefined}
          >
            {stagingBusy
              ? "Updating review…"
              : staged ? "Remove from review" : "Stage for review"}
          </button>
        )}
      </div>
      {view === "similarity" && canCompare && (
        <AnalysisDialog title="Similar folders" subtitle={path ?? node.name} onClose={() => setView(null)}>
          <SimilarFolders key={contentRevision} workspaceName={workspaceName} siteId={siteId} nodeId={node.id} />
        </AnalysisDialog>
      )}
      {view === "copies" && canCheckCopies && (
        <FileCopiesDialog
          key={contentRevision}
          workspaceName={workspaceName}
          siteId={siteId}
          source={{ name: node.name, site: siteName, path, size: node.total_bytes }}
          onJump={onJumpDuplicate}
          onClose={() => setView(null)}
        />
      )}
    </>
  );
}

interface SimilarFoldersProps {
  workspaceName: string;
  siteId: string;
  nodeId: string;
}

function SimilarFolders({ workspaceName, siteId, nodeId }: SimilarFoldersProps) {
  const load = useCallback((offset: number) => findSimilarFolders({
    workspace_name: workspaceName,
    site_id: siteId,
    node_id: nodeId,
    offset,
    limit: MATCH_PAGE_SIZE,
  }), [workspaceName, siteId, nodeId]);
  const { page, loading, error, goTo, retry } = useAnalysisPage(load);
  const [selected, setSelected] = useState<FolderSimilarityMatch | null>(null);

  function browse(offset: number) {
    setSelected(null);
    goTo(offset);
  }

  return (
    <section className="atlas-analysis-results" aria-busy={loading}>
      <div className="atlas-analysis-meta">
        <span>Matches use verified contents across all subfolders.</span>
        <button type="button" disabled={loading} onClick={() => browse(0)}>Refresh results</button>
      </div>
      {loading && !page && <p role="status">Comparing indexed contents…</p>}
      {error && <AnalysisError error={error} retry={retry} />}
      {page && (
        <>
          <dl className="atlas-analysis-facts">
            <div><dt>Verified source files</dt><dd>{formatCount(page.source.verified_file_count)} / {formatCount(page.source.file_count)}</dd></div>
            <div><dt>Distinct contents</dt><dd>{formatCount(page.source.distinct_content_count)}</dd></div>
            <div><dt>Extra copies</dt><dd>{formatCount(page.source.extra_copy_count)}</dd></div>
          </dl>
          <VerificationNote pending={page.workspace_pending_hash_count} incomplete={page.workspace_incomplete_site_count} />
          {page.matches.length ? (
            <ul className="atlas-analysis-list">
              {page.matches.map((match) => (
                <li key={JSON.stringify([match.folder.site_id, match.folder.node_id])}>
                  <button className="atlas-analysis-row" type="button" aria-pressed={match === selected} onClick={() => setSelected(match)}>
                    <span className="atlas-analysis-location">
                      <strong>{match.folder.site_name}</strong><small title={match.folder.path}>{match.folder.path}</small>
                    </span>
                    <span className="atlas-analysis-score">
                      <strong>{formatHealth(match.similarity)}%</strong>
                      <small>{match.partial ? "Partial" : match.identical_content ? "Same content" : "Similarity"}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">{page.source.distinct_content_count === 0 ? "Scan this folder to index content for comparison." : "No other indexed folders share verified content."}</p>
          )}
          <AnalysisPageControls page={page} loading={loading} goTo={browse} />
          {selected && <ComparisonDetails match={selected} />}
          <span className="atlas-analysis-timestamp">Snapshot {new Date(page.generated_at).toLocaleString()}</span>
        </>
      )}
    </section>
  );
}

function ComparisonDetails({ match }: { match: FolderSimilarityMatch }) {
  return (
    <section className="atlas-comparison-details" aria-label="Folder comparison details">
      <h3>{match.folder.site_name}</h3>
      <p className="atlas-analysis-path">{match.folder.path}</p>
      <dl className="atlas-analysis-values">
        <div><dt>Selected folder covered by match</dt><dd>{formatHealth(match.source_coverage)}%</dd></div>
        <div><dt>Match covered by selected folder</dt><dd>{formatHealth(match.target_coverage)}%</dd></div>
        <div><dt>Shared distinct content</dt><dd>{formatCount(match.shared_content_count)} · {formatBytes(match.shared_bytes)}</dd></div>
        <div><dt>Only in selected folder</dt><dd>{formatCount(match.source_only_count)} · {formatBytes(match.source_only_bytes)}</dd></div>
        <div><dt>Only in match</dt><dd>{formatCount(match.target_only_count)} · {formatBytes(match.target_only_bytes)}</dd></div>
        <div><dt>Match verified files</dt><dd>{formatCount(match.folder.verified_file_count)} / {formatCount(match.folder.file_count)}</dd></div>
        <div><dt>Match extra copies</dt><dd>{formatCount(match.folder.extra_copy_count)}</dd></div>
      </dl>
      {match.partial && <p role="status" className="atlas-analysis-warning">Results cover the verified portions of these folders.</p>}
    </section>
  );
}
