import { fileName, formatBytes, formatCount, percent } from "../lib/format";
import type { StorageNode } from "../lib/types";
import { CheckIcon, FolderIcon, LayersIcon } from "./Icons";

interface NodeDetailsProps {
  node: StorageNode;
  staged: boolean;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
}

export function NodeDetails({ node, staged, busy, onStage, onUnstage }: NodeDetailsProps) {
  const reclaimablePercent = percent(node.duplicate_bytes, node.total_bytes);
  const stageable = Boolean(node.path) && node.duplicate_bytes > 0 && node.kind !== "smaller_items";
  return (
    <aside className="node-details" aria-label="Selection details">
      <div className="detail-icon"><FolderIcon /></div>
      <span className="eyebrow">SELECTED</span>
      <h3 title={node.name}>{node.name || (node.path ? fileName(node.path) : "Site")}</h3>
      <p className="detail-path" title={node.path ?? undefined}>{node.path ?? "Entire site"}</p>

      <div className="detail-metrics">
        <div><span>Total size</span><strong>{formatBytes(node.total_bytes)}</strong></div>
        <div><span>Files</span><strong>{formatCount(node.file_count)}</strong></div>
        <div className="accent"><span>Reclaimable</span><strong>{formatBytes(node.duplicate_bytes)}</strong></div>
        <div><span>Duplicate ratio</span><strong>{Math.round(reclaimablePercent)}%</strong></div>
      </div>

      <div className="ratio-track"><span style={{ width: `${reclaimablePercent}%` }} /></div>
      <p className="detail-help">
        {stageable
          ? "Add this selection to review. NAFM will preserve at least one copy of every file."
          : "This selection has no safely reclaimable duplicate data."}
      </p>
      {staged ? (
        <button className="secondary-button full-width" type="button" onClick={onUnstage} disabled={busy}>
          <CheckIcon /> {busy ? "Updating…" : "Staged · Remove"}
        </button>
      ) : (
        <button className="primary-button full-width" type="button" onClick={onStage} disabled={!stageable || busy}>
          <LayersIcon /> {busy ? "Adding…" : "Add to review"}
        </button>
      )}
    </aside>
  );
}
