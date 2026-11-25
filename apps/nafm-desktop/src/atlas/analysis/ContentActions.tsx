import type { HealthMetric, StorageNode } from "../../lib/types";

export type ComparisonKind = "copies" | "similarity";

interface ContentActionsProps {
  node: StorageNode;
  metric: HealthMetric;
  staged: boolean;
  stagingBusy: boolean;
  sourceAnalysisReady?: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onReview?: () => void;
  onCompare: (kind: ComparisonKind) => void;
}

export function ContentActions({
  node,
  metric,
  staged,
  stagingBusy,
  sourceAnalysisReady = true,
  onStage,
  onUnstage,
  onReview,
  onCompare,
}: ContentActionsProps) {
  const path = node.path;
  const canCompare = node.kind === "directory" || node.kind === "local_root" || node.kind === "smb_root";
  const canCheckCopies = node.kind === "file" && path !== null;
  const canShowStage = metric === "space_health" && path !== null && (canCompare || canCheckCopies);
  const analysisReady = sourceAnalysisReady && node.pending_hash_count === 0;
  const canStage = analysisReady && (canCheckCopies ? node.duplicate_file_count > 0 : node.duplicate_bytes > 0);

  if (!canCompare && !canCheckCopies) return null;

  return (
    <div className="atlas-content-actions" role="group" aria-label="Content actions">
      {canCompare && (
        <button type="button" aria-haspopup="dialog" onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          onCompare("similarity");
        }}>
          Similar folders <span aria-hidden="true">↗</span>
        </button>
      )}
      {canCheckCopies && (
        <button type="button" aria-haspopup="dialog" onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          onCompare("copies");
        }}>
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
  );
}
