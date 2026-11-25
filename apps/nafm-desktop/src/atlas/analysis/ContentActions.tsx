import { useState } from "react";
import type {
  FileContentMatch,
  FolderSimilarityMatch,
  HealthMetric,
  StorageNode,
} from "../../lib/types";
import { FileCopiesDialog } from "./FileCopiesDialog";
import { SimilarFoldersDialog } from "./SimilarFoldersDialog";

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
  onReview?: () => void;
  onJumpDuplicate: (match: FileContentMatch, signal: AbortSignal) => Promise<string | null>;
  onJumpFolder: (match: FolderSimilarityMatch, signal: AbortSignal) => Promise<string | null>;
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
  onReview,
  onJumpDuplicate,
  onJumpFolder,
}: ContentActionsProps) {
  const [view, setView] = useState<AnalysisKind | null>(null);
  const path = node.path;
  const canCompare = node.kind === "directory" || node.kind === "local_root" || node.kind === "smb_root";
  const canCheckCopies = node.kind === "file" && path !== null;
  const canShowStage = metric === "space_health" && path !== null && (canCompare || canCheckCopies);
  const analysisReady = sourceAnalysisReady && node.pending_hash_count === 0;
  const canStage = analysisReady && (canCheckCopies ? node.duplicate_file_count > 0 : node.duplicate_bytes > 0);

  if (!canCompare && !canCheckCopies) return null;

  return (
    <>
      <div className="atlas-content-actions" role="group" aria-label="Content actions">
        {canCompare && (
          <button type="button" aria-haspopup="dialog" onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            setView("similarity");
          }}>
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
        {staged && onReview && (
          <button type="button" aria-haspopup="dialog" onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onReview();
          }}>
            Open review <span aria-hidden="true">↗</span>
          </button>
        )}
      </div>
      {view === "similarity" && canCompare && (
        <SimilarFoldersDialog
          key={contentRevision}
          workspaceName={workspaceName} siteId={siteId} siteName={siteName} node={node}
          onJump={onJumpFolder} onClose={() => setView(null)}
        />
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
