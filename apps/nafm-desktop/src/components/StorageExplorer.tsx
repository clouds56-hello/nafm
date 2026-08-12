import type { StorageNode, StorageTree } from "../lib/types";
import { formatBytes } from "../lib/format";
import { NodeDetails } from "./NodeDetails";
import { SunburstMap } from "./SunburstMap";

interface StorageExplorerProps {
  siteName: string;
  tree: StorageTree;
  node: StorageNode;
  staged: boolean;
  stagingBusy: boolean;
  onSelectNode: (node: StorageNode) => void;
  onStage: () => void;
  onUnstage: () => void;
}

export function StorageExplorer({ siteName, tree, node, staged, stagingBusy, onSelectNode, onStage, onUnstage }: StorageExplorerProps) {
  return (
    <section className="explorer-section" aria-labelledby="map-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">DUPLICATE MAP</span>
          <h2 id="map-title">Where your space can return</h2>
          <p>Arc size shows used space. Color intensity reveals safely reclaimable copies.</p>
        </div>
        <div className="map-total"><span>{siteName}</span><strong>{formatBytes(tree.root.duplicate_bytes)}</strong><small>reclaimable</small></div>
      </div>
      <div className="explorer-grid">
        <SunburstMap root={tree.root} selectedNodeId={node.id} onSelectNode={onSelectNode} />
        <NodeDetails node={node} staged={staged} busy={stagingBusy} onStage={onStage} onUnstage={onUnstage} />
      </div>
    </section>
  );
}
