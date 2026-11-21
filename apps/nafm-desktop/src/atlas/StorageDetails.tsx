import { formatBytes, formatCount } from "../lib/format";
import type { StorageNode, StorageViewSnapshot } from "../lib/types";

const percentage = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

interface StorageDetailsProps {
  snapshot: StorageViewSnapshot;
  selected: StorageNode | null;
}

function findContainingFolder(folder: StorageNode, id: string): StorageNode | undefined {
  for (const item of folder.children) {
    if (item.id === id) return folder;
    const container = findContainingFolder(item, id);
    if (container) return container;
  }
}

function formatShare(bytes: number, parentBytes: number) {
  if (parentBytes === 0) return "—";
  const ratio = Math.min(1, bytes / parentBytes);
  return ratio > 0 && ratio < 0.001 ? `<${percentage.format(0.001)}` : percentage.format(ratio);
}

function getVerification(node: StorageNode) {
  if (node.kind === "file") {
    if (node.verified_file_count > 0) return { status: "verified", label: "Hash verified" };
    if (node.pending_hash_count > 0) return { status: "pending", label: "Hash pending" };
    return { status: "unknown", label: "Not verified" };
  }

  if (node.file_count === 0) return { status: "unknown", label: "No files to verify" };
  const label = `${formatCount(node.verified_file_count)} of ${formatCount(node.file_count)} files verified`;
  return { status: node.verified_file_count === node.file_count ? "verified" : "pending", label };
}

export function StorageDetails({ snapshot, selected }: StorageDetailsProps) {
  const { root: folder, breadcrumbs } = snapshot.location;
  const node = selected ?? folder;
  const isDirectEntry = selected && snapshot.page.children.some((item) => item.id === selected.id);
  const container = selected
    ? isDirectEntry ? folder : findContainingFolder(folder, selected.id)
    : breadcrumbs.at(-2);
  const verification = getVerification(node);
  const heading = selected ? "Selected file" : node.kind === "site" ? "Current source" : "Current folder";

  return (
    <aside className="atlas-readout" aria-label="Storage details">
      <p className="atlas-kicker">{heading}</p>
      {node.kind !== "site" && <h2>{node.name}</h2>}
      <dl className="atlas-details">
        <div className="atlas-detail-path">
          <dt>Path</dt>
          <dd>{node.path ? <code>{node.path}</code> : "Site root"}</dd>
        </div>
        <div className="atlas-detail-metric">
          <dt>Size</dt>
          <dd>{formatBytes(node.total_bytes)}</dd>
        </div>
        {container && (
          <div className="atlas-detail-metric">
            <dt>Share of parent</dt>
            <dd title={container.total_bytes === 0 ? `${container.name} has no bytes` : container.name}>
              {formatShare(node.total_bytes, container.total_bytes)}
            </dd>
          </div>
        )}
        <div className="atlas-detail-metric">
          <dt>Verification</dt>
          <dd className="atlas-verification" data-status={verification.status}>{verification.label}</dd>
        </div>
      </dl>
    </aside>
  );
}
